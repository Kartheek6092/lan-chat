'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import type { Convo, StoredMessage } from '@/lib/db';
import type { Peer, JoinRequest } from '@/lib/chatClient';

const clean = (fp: string) => fp.replace(/\s/g, '');
const hue = (fp: string) => parseInt(clean(fp).slice(0, 4), 16) % 360;
const tail = (fp: string) => clean(fp).slice(0, 4);
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const hueStyle = (fp: string) => ({ '--h': hue(fp) }) as React.CSSProperties;

type Props = {
  convo: Convo; messages: StoredMessage[]; peers: Peer[]; verified: Record<string, boolean>;
  live: boolean; canSend: boolean; hint: string; inviteCode: string | null;
  isAdmin: boolean; joinRequests: JoinRequest[];
  onSend: (t: string) => void; onVerify: (fp: string) => void; onDm: (fp: string) => void;
  onLeave: () => void; onRejoin: () => void; onDelete: () => void; onBack: () => void;
  onRespond: (reqId: string, action: 'approve' | 'deny') => void;
};

export default function Thread(p: Props) {
  const [text, setText] = useState('');
  const [info, setInfo] = useState(false);
  const [copied, setCopied] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const isCh = p.convo.kind === 'ch';
  const shown = isCh ? p.peers : p.peers.filter(x => x.fp === p.convo.id.slice(3));

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [p.messages.length, p.convo.id]);
  useEffect(() => { setInfo(false); setCopied(false); }, [p.convo.id]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !p.canSend) return;
    p.onSend(text.trim()); setText('');
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(p.inviteCode || ''); setCopied(true); } catch { /* clipboard blocked */ }
  };

  const pendingRequests = p.isAdmin && isCh ? p.joinRequests : [];

  return (
    <main className="thread">
      <header className="thead">
        <button className="back" onClick={p.onBack} aria-label="Back to chats">‹</button>
        <div className="ttitle">
          <strong>{p.convo.title}</strong>
          <span>{isCh ? (p.live ? `${p.peers.length + 1} devices connected` : 'Not connected') : (p.canSend ? 'Connected' : 'Offline')}</span>
        </div>
        {p.isAdmin && isCh && pendingRequests.length > 0 && (
          <span className="req-badge" title="Pending join requests">{pendingRequests.length}</span>
        )}
        <button onClick={() => setInfo(!info)} aria-expanded={info}>{info ? 'Close' : 'Details'}</button>
        {isCh && (p.live ? <button onClick={p.onLeave}>Leave</button> : <button className="primary" onClick={p.onRejoin}>Rejoin</button>)}
      </header>

      {/* Admin join-request panel */}
      {pendingRequests.length > 0 && (
        <section className="req-panel">
          <h4 className="req-title">
            <span className="req-icon">🔔</span>
            Join requests
            <span className="req-count">{pendingRequests.length}</span>
          </h4>
          <ul className="req-list">
            {pendingRequests.map(r => (
              <li key={r.reqId} className="req-item">
                <span className="chip" style={hueStyle(r.fp)}>{r.name.slice(0, 2).toUpperCase()}</span>
                <div className="req-info">
                  <strong>{r.name}</strong>
                  <span className="mono req-fp">{r.fp.slice(0, 14)}…</span>
                </div>
                <div className="req-btns">
                  <button className="primary req-approve" onClick={() => p.onRespond(r.reqId, 'approve')}>✓ Approve</button>
                  <button className="danger-sm req-deny" onClick={() => p.onRespond(r.reqId, 'deny')}>✗ Deny</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {info && (
        <section className="details">
          {isCh && p.inviteCode && (
            <div className="invite">
              <span>Invite code</span>
              <code className="mono">{p.inviteCode}</code>
              <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          )}
          {p.isAdmin && isCh && (
            <p className="admin-tag">👑 You are the channel admin</p>
          )}
          {shown.length === 0 && <p className="empty">No connected devices.</p>}
          {shown.map(d => (
            <div className="device" key={d.cid}>
              <span className="chip" style={hueStyle(d.fp)}>{d.name.slice(0, 2).toUpperCase()}</span>
              <div className="dtext">
                <strong>{d.name}</strong>
                <span className="mono">{d.fp.slice(0, 14)}… · code {d.code}</span>
                <span className={p.verified[d.fp] ? 'ok' : 'warn'}>
                  {p.verified[d.fp] ? 'Verified' : 'Not verified. Compare the code aloud on both devices.'}
                </span>
              </div>
              <div className="dbtns">
                <button onClick={() => p.onVerify(d.fp)}>{p.verified[d.fp] ? 'Unverify' : 'Mark verified'}</button>
                {isCh && <button onClick={() => p.onDm(d.fp)}>Message</button>}
              </div>
            </div>
          ))}
          <button className="danger" onClick={p.onDelete}>Delete this chat from this device</button>
        </section>
      )}

      <div className="log" aria-live="polite">
        {p.messages.length === 0 && <p className="empty center">No messages yet. They are stored only on this device.</p>}
        {p.messages.map(m => (
          <div key={m.id} className={`msg ${m.mine ? 'mine' : ''}`}>
            {!m.mine && <span className="chip" style={hueStyle(m.fp)} title={m.name}>{m.name.slice(0, 2).toUpperCase()}</span>}
            <div className="bubble">
              {!m.mine && isCh && <div className="from">{m.name} <span className="mono">{tail(m.fp)}</span></div>}
              <div className="mtext">{m.text}</div>
              <div className="time">{hhmm(m.ts)}</div>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>

      {p.hint && <p className="hint">{p.hint}</p>}
      <form className="composer" onSubmit={submit}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={p.canSend ? 'Type a message' : 'Not available right now'}
          disabled={!p.canSend} autoComplete="off" aria-label="Message" maxLength={4000} />
        <button className="primary" disabled={!p.canSend || !text.trim()}>Send</button>
      </form>
    </main>
  );
}
