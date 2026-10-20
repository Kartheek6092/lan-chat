'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import nacl from 'tweetnacl';
import { hex } from '@/lib/encoding';
import { fingerprint, loadIdentity, channelIdFor, newCode, KeyPair } from '@/lib/chatCrypto';
import { ChatClient, JoinRequest, Peer } from '@/lib/chatClient';
import {
  Contact, Convo, SavedChannel, StoredMessage,
  deleteConvo, ensureConvo, get, getAll, markRead, messagesFor, put, recordMessage,
} from '@/lib/db';
import Sidebar, { Nearby } from './Sidebar';
import Thread from './Thread';

const NAME_KEY = 'lanchat.name';

export default function ChatApp() {
  const [me, setMe] = useState<{ id: KeyPair; fp: string } | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [convos, setConvos] = useState<Convo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<StoredMessage[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [live, setLive] = useState<SavedChannel | null>(null);
  const [status, setStatus] = useState('Not connected');
  const [nearby, setNearby] = useState<Nearby[]>([]);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<'list' | 'chat'>('list');
  const [isAdmin, setIsAdmin] = useState(false);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);

  const client = useRef<ChatClient | null>(null);
  const activeRef = useRef<string | null>(null);
  const contacts = useRef<Record<string, Contact>>({});

  const refresh = useCallback(async () => {
    setConvos((await getAll<Convo>('convos')).sort((a, b) => b.lastTs - a.lastTs));
  }, []);

  useEffect(() => {
    const id = loadIdentity();
    const n = localStorage.getItem(NAME_KEY) || `Device-${hex(nacl.randomBytes(2))}`;
    localStorage.setItem(NAME_KEY, n);
    setMe({ id, fp: fingerprint(id.publicKey) });
    setName(n);
    refresh();
    getAll<Contact>('contacts').then(all => {
      contacts.current = Object.fromEntries(all.map(c => [c.fp, c]));
      setVerified(Object.fromEntries(all.map(c => [c.fp, c.verified])));
    });
    return () => client.current?.leave();
  }, [refresh]);

  // Discover channels other devices chose to show on this network.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try { const r = await fetch('/api/channels', { cache: 'no-store' }); const j = await r.json(); if (!stop) setNearby(j); } catch { /* offline */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  // Remember devices we have talked to; keep their verified flag.
  useEffect(() => {
    for (const p of peers) {
      const c: Contact = { fp: p.fp, name: p.name, verified: contacts.current[p.fp]?.verified ?? false, lastSeen: Date.now() };
      contacts.current[p.fp] = c;
      void put('contacts', c);
    }
    setVerified(Object.fromEntries(Object.values(contacts.current).map(c => [c.fp, c.verified])));
  }, [peers]);

  const openConvo = useCallback(async (id: string) => {
    activeRef.current = id;
    setActive(id);
    setView('chat');
    setMsgs(await messagesFor(id));
    await markRead(id);
    refresh();
  }, [refresh]);

  const onIncoming = useCallback(async (m: StoredMessage) => {
    const isActive = m.convo === activeRef.current;
    await recordMessage(m, m.name, isActive);
    if (isActive) setMsgs(x => [...x, m]);
    refresh();
  }, [refresh]);

  /** Core join — always called once we have the code (either directly or after admin approval). */
  const joinChannel = async (ch: SavedChannel, asAdmin = false) => {
    if (!me) return;
    const known = await get<SavedChannel>('channels', ch.id);
    const chan = { ...ch, name: known?.name ?? ch.name };
    await put('channels', chan);
    await ensureConvo(`ch:${chan.id}`, chan.name);
    client.current?.leave();
    setIsAdmin(false);
    setJoinRequests([]);
    client.current = new ChatClient(me.id, name, {
      status: setStatus,
      peers: setPeers,
      message: m => { void onIncoming(m); },
      closed: r => { setStatus(r); setLive(null); },
      role: role => { setIsAdmin(role === 'admin'); },
      joinRequests: reqs => { setJoinRequests(reqs); },
    });
    setLive(chan);
    client.current.join(chan, asAdmin);
    await openConvo(`ch:${chan.id}`);
  };

  /** Join using an explicit code (private channel or code-share) */
  const joinByCode = (code: string, knownName?: string) =>
    joinChannel(
      { id: channelIdFor(code), code, name: knownName || `Channel ${code.replace(/[^a-z0-9]/gi, '').slice(0, 4)}`, listed: false },
      false,
    );

  /** Create a new channel — creator is always the admin */
  const create = (chName: string, listed: boolean) => {
    const code = newCode();
    return joinChannel({ id: channelIdFor(code), code, name: chName, listed }, true);
  };

  /** Send a join REQUEST for a listed (public) channel — no code needed by requester */
  const requestJoin = async (n: Nearby): Promise<{ status: string; reqId?: string; code?: string }> => {
    if (!me) return { status: 'error' };
    const res = await fetch('/api/join-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: n.id, name, fp: me.fp }),
    });
    return res.json();
  };

  /** Poll for approval status */
  const pollApproval = async (channelId: string, reqId: string): Promise<{ status: string; code?: string }> => {
    if (!me) return { status: 'error' };
    const res = await fetch(`/api/join-request/status?channelId=${channelId}&reqId=${reqId}&fp=${encodeURIComponent(me.fp)}`);
    return res.json();
  };

  /** Admin approves or denies a request */
  const respondToRequest = async (reqId: string, action: 'approve' | 'deny') => {
    if (!me || !live) return;
    await fetch('/api/join-request/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: live.id, adminFp: me.fp, reqId, action }),
    });
    // Remove from local state immediately
    setJoinRequests(prev => prev.filter(r => r.reqId !== reqId));
  };

  const leave = () => { client.current?.leave(); setLive(null); setPeers([]); setStatus('Not connected'); setIsAdmin(false); setJoinRequests([]); };

  const rename = async (n: string) => {
    const v = n.trim().slice(0, 24) || name;
    setNameError('');
    // Check uniqueness with server
    try {
      const res = await fetch(`/api/check-name?name=${encodeURIComponent(v)}`);
      if (res.ok) {
        const { taken } = await res.json();
        if (taken && v.toLowerCase() !== name.toLowerCase()) {
          setNameError('That name is already taken by a connected device. Please choose another.');
          return;
        }
      }
    } catch { /* offline – allow */ }
    setName(v);
    localStorage.setItem(NAME_KEY, v);
  };

  const toggleVerified = (fp: string) => {
    const c = contacts.current[fp];
    if (!c) return;
    contacts.current[fp] = { ...c, verified: !c.verified };
    void put('contacts', contacts.current[fp]);
    setVerified(v => ({ ...v, [fp]: !c.verified }));
  };

  const convo = convos.find(c => c.id === active) || null;

  const openDm = async (fp: string) => {
    const peer = peers.find(p => p.fp === fp);
    if (!peer) return;
    await ensureConvo(`dm:${fp}`, peer.name);
    await refresh();
    await openConvo(`dm:${fp}`);
  };

  const send = async (text: string) => {
    const c = client.current;
    if (!c || !convo) return;
    const isDm = convo.kind === 'dm';
    const fp = convo.id.slice(3);
    const m = isDm ? c.sendDm(fp, text) : c.sendChannel(text);
    if (!m) { setStatus(isDm ? 'That device is not connected right now' : 'No one else is connected yet'); return; }
    await recordMessage(m, peers.find(p => p.fp === fp)?.name ?? convo.title, true);
    setMsgs(x => [...x, m]);
    refresh();
  };

  const remove = async () => {
    if (!convo || !confirm('Delete this chat and its messages from this device? Other devices keep their own copies.')) return;
    if (convo.kind === 'ch' && live?.id === convo.id.slice(3)) leave();
    await deleteConvo(convo.id);
    setActive(null); activeRef.current = null; setMsgs([]); setView('list');
    refresh();
  };

  const rejoin = async () => {
    if (!convo) return;
    const ch = await get<SavedChannel>('channels', convo.id.slice(3));
    if (ch) joinChannel(ch);
  };

  let canSend = false, hint = '';
  if (convo?.kind === 'ch') {
    const isLive = live?.id === convo.id.slice(3);
    canSend = isLive && peers.length > 0;
    hint = !isLive ? 'You are not connected to this channel.' : peers.length === 0 ? 'Waiting for another device to join.' : '';
  } else if (convo) {
    canSend = peers.some(p => p.fp === convo.id.slice(3));
    hint = canSend ? '' : 'This device is not connected right now. Rejoin the shared channel to reach it.';
  }

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  useEffect(() => {
    if (convo?.kind !== 'ch') return setInviteCode(null);
    get<SavedChannel>('channels', convo.id.slice(3)).then(c => setInviteCode(c?.code ?? null));
  }, [convo?.id, convo?.kind]);

  return (
    <div className="app" data-view={view}>
      <Sidebar
        name={name} fp={me?.fp ?? ''} status={status} nameError={nameError}
        convos={convos} activeId={active} liveId={live?.id ?? null} onlineFps={new Set(peers.map(p => p.fp))}
        nearby={nearby} onRename={rename} onOpen={openConvo} onJoin={joinByCode} onCreate={create}
        onRequestJoin={requestJoin} onPollApproval={pollApproval}
        onJoinApproved={(n, code) => joinByCode(code, n.name)}
      />
      {convo ? (
        <Thread
          convo={convo} messages={msgs} peers={peers} verified={verified}
          live={live?.id === convo.id.slice(3)} canSend={canSend} hint={hint} inviteCode={inviteCode}
          isAdmin={isAdmin} joinRequests={joinRequests} onRespond={respondToRequest}
          onSend={send} onVerify={toggleVerified} onDm={openDm}
          onLeave={leave} onRejoin={rejoin} onDelete={remove} onBack={() => setView('list')}
        />
      ) : (
        <main className="thread blank">
          <div>
            <h2>Private chat on your own network</h2>
            <p>Create a channel and share its code, or join one that is nearby. Messages are end-to-end encrypted and saved only on each device.</p>
          </div>
        </main>
      )}
    </div>
  );
}
