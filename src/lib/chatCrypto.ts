// Protocol "chat-v2": per-pair signed ephemeral X25519 exchange, mixed with a channel secret (PSK),
// -> per-direction keys -> secretbox with counter nonces. Pure TypeScript; swap for Noise XX later.
import nacl from 'tweetnacl';
import { b64, unb64, hex, cat } from './encoding';

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
export type Hello = { t: 'hello'; id: string; e: string; s: string; nm: string; to?: string; from?: string };
export type Packet = { t: 'msg'; n: number; c: string; to?: string; from?: string };

const enc = new TextEncoder();
const dec = new TextDecoder();
const ID_KEY = 'lanchat.id';

export function loadIdentity(): KeyPair {
  try {
    const s = JSON.parse(localStorage.getItem(ID_KEY) || '');
    return { publicKey: unb64(s.p), secretKey: unb64(s.s) };
  } catch {
    const k = nacl.sign.keyPair();
    localStorage.setItem(ID_KEY, JSON.stringify({ p: b64(k.publicKey), s: b64(k.secretKey) }));
    return k;
  }
}

export const fingerprint = (pub: Uint8Array): string =>
  hex(nacl.hash(pub).slice(0, 16)).match(/.{4}/g)!.join(' ');

// Channel codes: 64 random bits, shown as xxxx-xxxx-xxxx-xxxx. Dashes and case are ignored when typing.
export const normalizeCode = (c: string): string => c.toLowerCase().replace(/[^a-z0-9]/g, '');
export const newCode = (): string => hex(nacl.randomBytes(8)).match(/.{4}/g)!.join('-');
export const channelIdFor = (code: string): string =>
  hex(nacl.hash(enc.encode('lanchat-id|' + normalizeCode(code))).slice(0, 16));
const pskFor = (code: string): Uint8Array =>
  nacl.hash(enc.encode('lanchat-psk|' + normalizeCode(code))).slice(0, 32);

const context = (channelId: string) => enc.encode(`chat-v2|${channelId}|`);

const nonce = (n: number): Uint8Array => {
  const x = new Uint8Array(24);
  const v = new DataView(x.buffer);
  v.setUint32(16, Math.floor(n / 2 ** 32));
  v.setUint32(20, n >>> 0);
  return x;
};

export function createHello(id: KeyPair, channelId: string, name: string): { eph: KeyPair; hello: Hello } {
  const eph = nacl.box.keyPair();
  const nm = name.slice(0, 40);
  const sig = nacl.sign.detached(cat(context(channelId), eph.publicKey, enc.encode(nm)), id.secretKey);
  return { eph, hello: { t: 'hello', id: b64(id.publicKey), e: b64(eph.publicKey), s: b64(sig), nm } };
}

export class Session {
  private sendN = 0;
  private recvN = -1;

  constructor(
    private kSend: Uint8Array,
    private kRecv: Uint8Array,
    readonly peerFingerprint: string,
    readonly sessionCode: string,
  ) {}

  encrypt(text: string): Packet {
    const n = this.sendN++;
    return { t: 'msg', n, c: b64(nacl.secretbox(enc.encode(text), nonce(n), this.kSend)) };
  }

  /** Plaintext, or null if the packet is replayed, malformed or fails authentication. */
  decrypt(p: Packet): string | null {
    if (!Number.isSafeInteger(p.n) || p.n <= this.recvN || typeof p.c !== 'string') return null;
    try {
      const out = nacl.secretbox.open(unb64(p.c), nonce(p.n), this.kRecv);
      if (!out) return null;
      this.recvN = p.n;
      return dec.decode(out);
    } catch { return null; }
  }
}

/** Verifies a peer's signed hello and derives the pairwise session. Null if anything is invalid. */
export function openSession(
  id: KeyPair, eph: KeyPair, channelId: string, code: string, m: Hello,
): { session: Session; name: string } | null {
  try {
    const idp = unb64(m.id), ep = unb64(m.e), sg = unb64(m.s);
    const nm = typeof m.nm === 'string' ? m.nm.slice(0, 40) : '';
    if (idp.length !== 32 || ep.length !== 32) return null;
    if (!nacl.sign.detached.verify(cat(context(channelId), ep, enc.encode(nm)), sg, idp)) return null;

    const shared = nacl.box.before(ep, eph.secretKey);
    const psk = pskFor(code);
    const kSend = nacl.hash(cat(shared, psk, eph.publicKey, ep)).slice(0, 32);
    const kRecv = nacl.hash(cat(shared, psk, ep, eph.publicKey)).slice(0, 32);

    const ids = [hex(id.publicKey), hex(idp)].sort().join('');
    const ephs = [hex(eph.publicKey), hex(ep)].sort().join('');
    const h = nacl.hash(enc.encode(ids + ephs));
    const sessionCode = [0, 2, 4].map(i => String(((h[i] << 8) | h[i + 1]) % 10000).padStart(4, '0')).join(' ');

    return { session: new Session(kSend, kRecv, fingerprint(idp), sessionCode), name: nm || 'Unnamed device' };
  } catch { return null; }
}
