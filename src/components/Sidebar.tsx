'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import type { Convo } from '@/lib/db';
import { channelIdFor, normalizeCode } from '@/lib/chatCrypto';

export type Nearby = { id: string; name: string; count: number };

type Props = {
  name: string; fp: string; status: string; nameError?: string;
  convos: Convo[]; activeId: string | null; liveId: string | null; onlineFps: Set<string>;
  nearby: Nearby[];
  onRename: (n: string) => void;
  onOpen: (id: string) => void;
  onJoin: (code: string, name?: string) => void;
  onCreate: (name: string, listed: boolean) => void;
  onRequestJoin: (n: Nearby) => Promise<{ status: string; reqId?: string; code?: string }>;
  onPollApproval: (channelId: string, reqId: string) => Promise<{ status: string; code?: string }>;
  onJoinApproved: (n: Nearby, code: string) => void;
};

type NearbyState =
  | { phase: 'idle' }
  | { phase: 'pending'; reqId: string }
  | { phase: 'denied' };

const CODE_ERR = 'Enter the full 16-character code, like a1b2-c3d4-e5f6-0718.';

export default function Sidebar(p: Props) {
  const [mode, setMode] = useState<'none' | 'create' | 'join'>('none');
  const [chName, setChName] = useState('');
  const [listed, setListed] = useState(true);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [nameDraft, setNameDraft] = useState(p.name);
  // Per-nearby-channel state
  const [nearbyState, setNearbyState] = useState<Record<string, NearbyState>>({});
  // For private channels shown in nearby (they shouldn't appear, but keep as fallback)
  const [askId, setAskId] = useState<string | null>(null);
  const [askCode, setAskCode] = useState('');

  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Keep name draft in sync with external name
  useEffect(() => { setNameDraft(p.name); }, [p.name]);

  const channels = p.convos.filter(c => c.kind === 'ch');
  const dms = p.convos.filter(c => c.kind === 'dm');
  const saved = new Set(channels.map(c => c.id.slice(3)));
  const nearby = p.nearby.filter(n => !saved.has(n.id));

  // Clean up poll intervals
  useEffect(() => {
    return () => { Object.values(pollTimers.current).forEach(clearInterval); };
  }, []);

  const startPolling = (n: Nearby, reqId: string) => {
    if (pollTimers.current[n.id]) clearInterval(pollTimers.current[n.id]);
    pollTimers.current[n.id] = setInterval(async () => {
      const res = await p.onPollApproval(n.id, reqId);
      if (res.status === 'approved' && res.code) {
        clearInterval(pollTimers.current[n.id]);
        delete pollTimers.current[n.id];
        setNearbyState(s => ({ ...s, [n.id]: { phase: 'idle' } }));
        p.onJoinApproved(n, res.code);
      } else if (res.status === 'denied') {
        clearInterval(pollTimers.current[n.id]);
        delete pollTimers.current[n.id];
        setNearbyState(s => ({ ...s, [n.id]: { phase: 'denied' } }));
      }
    }, 2500);
  };

  const handleRequestJoin = async (n: Nearby) => {
    setErr('');
    const res = await p.onRequestJoin(n);
    if (res.status === 'approved' && res.code) {
      p.onJoinApproved(n, res.code);
    } else if (res.status === 'pending' && res.reqId) {
      setNearbyState(s => ({ ...s, [n.id]: { phase: 'pending', reqId: res.reqId! } }));
      startPolling(n, res.reqId);
    } else if (res.status === 'denied') {
      setNearbyState(s => ({ ...s, [n.id]: { phase: 'denied' } }));
    } else {
      setErr('Could not send join request. Try again.');
    }
  };

  const submitJoin = (e: FormEvent) => {
    e.preventDefault();
    if (normalizeCode(code).length < 16) return setErr(CODE_ERR);
    p.onJoin(code); setCode(''); setErr(''); setMode('none');
  };

  const submitAsk = (e: FormEvent, n: Nearby) => {
    e.preventDefault();
    if (channelIdFor(askCode) !== n.id) return setErr("That code doesn't match this channel.");
    p.onJoin(askCode, n.name); setAskId(null); setAskCode(''); setErr('');
  };

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    p.onCreate(chName.trim() || 'New channel', listed); setChName(''); setMode('none');
  };

  const row = (c: Convo) => {
    const online = c.kind === 'ch' ? p.liveId === c.id.slice(3) : p.onlineFps.has(c.id.slice(3));
    return (
      <li key={c.id}>
        <button className={`row ${p.activeId === c.id ? 'on' : ''}`} onClick={() => p.onOpen(c.id)}>
          <span className={`dot ${online ? 'live' : ''}`} aria-label={online ? 'connected' : 'offline'} />
          <span className="rowtext">
            <span className="rowtitle">{c.title}</span>
            <span className="rowsub">{c.preview || (online ? 'Connected' : 'No messages yet')}</span>
          </span>
          {c.unread > 0 && <span className="badge">{c.unread}</span>}
        </button>
      </li>
    );
  };

  const renderNearbyItem = (n: Nearby) => {
    const state = nearbyState[n.id] ?? { phase: 'idle' };

    return (
      <li key={n.id}>
        <button className="row" onClick={() => {
          if (state.phase === 'idle') handleRequestJoin(n);
          else if (state.phase === 'denied') {
            setNearbyState(s => ({ ...s, [n.id]: { phase: 'idle' } }));
          }
        }}>
          <span className={`dot nearby ${state.phase === 'pending' ? 'pending-dot' : ''}`} />
          <span className="rowtext">
            <span className="rowtitle">{n.name}</span>
            <span className="rowsub">
              {state.phase === 'idle' && `${n.count} ${n.count === 1 ? 'device' : 'devices'} · tap to request`}
              {state.phase === 'pending' && '⏳ Waiting for admin approval…'}
              {state.phase === 'denied' && '✗ Request denied — tap to retry'}
            </span>
          </span>
          {state.phase === 'pending' && <span className="spinner" aria-label="Waiting" />}
        </button>
        {/* Fallback code entry — only shown if somehow a non-listed channel sneaks through */}
        {askId === n.id && (
          <form className="panel inline" onSubmit={e => submitAsk(e, n)}>
            <input className="mono" autoFocus value={askCode} onChange={e => setAskCode(e.target.value)} placeholder="Enter code" aria-label={`Code for ${n.name}`} />
            <button className="primary">Join</button>
          </form>
        )}
      </li>
    );
  };

  return (
    <aside className="side">
      <div className="brand">
        <strong>LAN Chat</strong>
        <span className="status">{p.status}</span>
      </div>

      <label className="devname">
        <span>This device</span>
        <input value={nameDraft} maxLength={24} onChange={e => setNameDraft(e.target.value)}
          onBlur={() => p.onRename(nameDraft)} aria-label="Device name" />
        <small className="mono">{p.fp.slice(0, 9)}</small>
      </label>
      {p.nameError && <p className="err name-err" role="alert">{p.nameError}</p>}

      <div className="actions">
        <button className={mode === 'create' ? 'primary' : ''} onClick={() => { setMode(mode === 'create' ? 'none' : 'create'); setErr(''); }}>New channel</button>
        <button className={mode === 'join' ? 'primary' : ''} onClick={() => { setMode(mode === 'join' ? 'none' : 'join'); setErr(''); }}>Join with code</button>
      </div>

      {mode === 'create' && (
        <form className="panel" onSubmit={submitCreate}>
          <input value={chName} maxLength={40} onChange={e => setChName(e.target.value)} placeholder="Channel name" aria-label="Channel name" />
          <label className="check">
            <input type="checkbox" checked={listed} onChange={e => setListed(e.target.checked)} />
            Show in "Nearby" for devices on this Wi-Fi
          </label>
          <small>{listed
            ? "Nearby devices can request to join — you'll approve each one. Share the code only for private access."
            : 'Private channel: only joinable by sharing the code directly.'
          }</small>
          <button className="primary">Create and join</button>
        </form>
      )}
      {mode === 'join' && (
        <form className="panel" onSubmit={submitJoin}>
          <input className="mono" value={code} onChange={e => setCode(e.target.value)} placeholder="a1b2-c3d4-e5f6-0718" aria-label="Channel code" autoComplete="off" />
          <button className="primary">Join</button>
        </form>
      )}
      {err && <p className="err" role="alert">{err}</p>}

      <div className="scroll">
        {nearby.length > 0 && (
          <section>
            <h3>Nearby</h3>
            <ul>{nearby.map(renderNearbyItem)}</ul>
          </section>
        )}
        <section>
          <h3>Channels</h3>
          {channels.length ? <ul>{channels.map(row)}</ul> : <p className="empty">Create a channel or join one with a code.</p>}
        </section>
        {dms.length > 0 && (
          <section>
            <h3>Direct messages</h3>
            <ul>{dms.map(row)}</ul>
          </section>
        )}
      </div>
    </aside>
  );
}
