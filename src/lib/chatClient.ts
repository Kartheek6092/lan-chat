// Network + crypto orchestration for one channel. No React. Keeps one encrypted session per peer device.
import nacl from 'tweetnacl';
import { hex } from './encoding';
import { KeyPair, Session, Hello, Packet, createHello, openSession, fingerprint } from './chatCrypto';
import type { StoredMessage } from './db';

export type Peer = { cid: string; name: string; fp: string; code: string };
export type JoinRequest = { reqId: string; name: string; fp: string; ts: number };
export type Events = {
  status: (s: string) => void;
  peers: (p: Peer[]) => void;
  message: (m: StoredMessage) => void;
  closed: (reason: string) => void;
  role?: (role: 'admin' | 'member') => void;
  joinRequests?: (requests: JoinRequest[]) => void;
};

export class ChatClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, KeyPair>();
  private sessions = new Map<string, { session: Session; name: string; ok: boolean }>();
  private channelId = '';
  private code = '';

  constructor(private id: KeyPair, private name: string, private ev: Events) {}

  get myFp() { return fingerprint(this.id.publicKey); }

  join(ch: { id: string; code: string; name: string; listed: boolean }, isAdmin = false) {
    this.leave();
    this.channelId = ch.id;
    this.code = ch.code;
    const q = new URLSearchParams({
      ch: ch.id,
      listed: ch.listed ? '1' : '0',
      name: ch.listed ? ch.name : '',
      fp: this.myFp,
      code: ch.code,
      admin: isAdmin ? '1' : '0',
      devname: this.name,
    });
    const ws = new WebSocket(`wss://${location.host}/ws?${q}`);
    this.ws = ws;
    ws.onopen = () => this.ev.status('Connected');
    ws.onmessage = e => this.onRaw(String(e.data));
    ws.onclose = e => { if (this.ws === ws) { this.ws = null; this.reset(); this.ev.closed(e.reason || 'Disconnected'); } };
  }

  leave() {
    const w = this.ws;
    this.ws = null;
    w?.close();
    this.reset();
  }

  private reset() { this.pending.clear(); this.sessions.clear(); this.ev.peers([]); }

  private send(o: object) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }

  private hello(cid: string) {
    const { eph, hello } = createHello(this.id, this.channelId, this.name);
    this.pending.set(cid, eph);
    this.send({ ...hello, to: cid });
  }

  private emitPeers() {
    const peers = [...this.sessions].filter(([, s]) => s.ok).map(([cid, s]) => ({ cid, name: s.name, fp: s.session.peerFingerprint, code: s.session.sessionCode }));
    this.ev.peers(peers);
    this.ev.status(peers.length ? `${peers.length + 1} devices connected` : 'Waiting for others to join');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onRaw(raw: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'welcome':
        for (const cid of m.members as string[]) this.hello(cid);
        this.ev.status(m.members.length ? 'Securing connections' : 'Waiting for others to join');
        break;
      case 'joined': this.hello(m.cid); break;
      case 'left': this.pending.delete(m.cid); this.sessions.delete(m.cid); this.emitPeers(); break;
      case 'hello': this.onHello(m as Hello); break;
      case 'msg': this.onPacket(m as Packet); break;
      case 'role': this.ev.role?.(m.role); break;
      case 'join_requests': this.ev.joinRequests?.(m.requests as JoinRequest[]); break;
    }
  }

  private onHello(m: Hello) {
    const from = m.from || '';
    const eph = this.pending.get(from);
    if (!eph) return;
    const r = openSession(this.id, eph, this.channelId, this.code, m);
    this.pending.delete(from);
    if (!r) { this.ev.status('Rejected an invalid handshake'); return; }
    this.sessions.set(from, { ...r, ok: false });
    // Key confirmation: the peer only counts once it proves it derived the same keys (same channel code).
    this.send({ ...r.session.encrypt(JSON.stringify({ k: 'hi' })), to: from });
  }

  private onPacket(p: Packet) {
    const s = this.sessions.get(p.from || '');
    if (!s) return;
    const plain = s.session.decrypt(p);
    if (plain === null) return;
    if (!s.ok) { s.ok = true; this.emitPeers(); }
    let body: { k?: string; id?: string; text?: string };
    try { body = JSON.parse(plain); } catch { return; }
    if (body.k === 'hi') return;
    if (typeof body.text !== 'string' || typeof body.id !== 'string' || body.text.length > 4000) return;
    const fp = s.session.peerFingerprint;
    this.ev.message({
      id: `${fp.replace(/ /g, '')}-${body.id}`,
      convo: body.k === 'dm' ? `dm:${fp}` : `ch:${this.channelId}`,
      fp, name: s.name, mine: false, text: body.text, ts: Date.now(),
    });
  }

  /** Sends to every connected device in the channel. Null if nobody is connected. */
  sendChannel(text: string): StoredMessage | null {
    return this.fan('ch', text, [...this.sessions].filter(([, s]) => s.ok).map(([cid]) => cid));
  }

  /** Sends only to the device with this fingerprint. Null if it is not connected. */
  sendDm(fp: string, text: string): StoredMessage | null {
    const cid = [...this.sessions].find(([, s]) => s.ok && s.session.peerFingerprint === fp)?.[0];
    return cid ? this.fan('dm', text, [cid], fp) : null;
  }

  private fan(k: 'ch' | 'dm', text: string, cids: string[], dmFp?: string): StoredMessage | null {
    if (!cids.length) return null;
    const mid = hex(nacl.randomBytes(8));
    const body = JSON.stringify({ k, id: mid, text });
    for (const cid of cids) this.send({ ...this.sessions.get(cid)!.session.encrypt(body), to: cid });
    return { id: `me-${mid}`, convo: k === 'dm' ? `dm:${dmFp}` : `ch:${this.channelId}`, fp: this.myFp, name: this.name, mine: true, text, ts: Date.now() };
  }
}
