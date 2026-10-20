// Local-only storage (IndexedDB). Nothing here is ever sent to the server.
export type StoredMessage = { id: string; convo: string; fp: string; name: string; mine: boolean; text: string; ts: number };
export type Convo = { id: string; kind: 'ch' | 'dm'; title: string; lastTs: number; preview: string; unread: number };
export type SavedChannel = { id: string; code: string; name: string; listed: boolean };
export type Contact = { fp: string; name: string; verified: boolean; lastSeen: number };

let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('lanchat', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('messages', { keyPath: 'id' }).createIndex('convo', 'convo');
    d.createObjectStore('convos', { keyPath: 'id' });
    d.createObjectStore('channels', { keyPath: 'id' });
    d.createObjectStore('contacts', { keyPath: 'fp' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));

async function run<R>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<R>): Promise<R> {
  const d = await db();
  return new Promise<R>((res, rej) => {
    const q = f(d.transaction(store, mode).objectStore(store));
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

export const put = (store: string, v: unknown) => run(store, 'readwrite', s => s.put(v));
export const get = <T>(store: string, key: string) => run<T | undefined>(store, 'readonly', s => s.get(key));
export const getAll = <T>(store: string) => run<T[]>(store, 'readonly', s => s.getAll());

export const messagesFor = async (convo: string) =>
  (await run<StoredMessage[]>('messages', 'readonly', s => s.index('convo').getAll(convo))).sort((a, b) => a.ts - b.ts);

export async function recordMessage(m: StoredMessage, title: string, active: boolean) {
  await put('messages', m);
  const kind = m.convo.startsWith('dm:') ? 'dm' : 'ch';
  const c = (await get<Convo>('convos', m.convo)) ?? { id: m.convo, kind, title, lastTs: 0, preview: '', unread: 0 };
  await put('convos', {
    ...c,
    title: kind === 'dm' ? title : c.title,
    lastTs: m.ts,
    preview: `${m.mine ? 'You' : m.name}: ${m.text.slice(0, 60)}`,
    unread: active || m.mine ? 0 : c.unread + 1,
  } satisfies Convo);
}

export async function ensureConvo(id: string, title: string) {
  const old = await get<Convo>('convos', id);
  if (!old) await put('convos', { id, kind: id.startsWith('dm:') ? 'dm' : 'ch', title, lastTs: Date.now(), preview: '', unread: 0 } satisfies Convo);
}

export async function markRead(id: string) {
  const c = await get<Convo>('convos', id);
  if (c && c.unread) await put('convos', { ...c, unread: 0 });
}

export async function deleteConvo(id: string) {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const t = d.transaction(['messages', 'convos', 'channels'], 'readwrite');
    const idx = t.objectStore('messages').index('convo');
    idx.getAllKeys(id).onsuccess = e => {
      for (const k of (e.target as IDBRequest<IDBValidKey[]>).result) t.objectStore('messages').delete(k);
    };
    t.objectStore('convos').delete(id);
    if (id.startsWith('ch:')) t.objectStore('channels').delete(id.slice(3));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
