export const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));

export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export const hex = (u: Uint8Array): string => Array.from(u, x => x.toString(16).padStart(2, '0')).join('');

export const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
