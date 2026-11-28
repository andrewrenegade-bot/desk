// crypto.js - decrypts plan B data files (see deskcrypto.py). Browser + Node 20+ (globalThis.crypto).
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
function unb64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function parseFragment(hash) {
  const m = /^#?d=([A-Za-z0-9]{32,})\.([A-Za-z0-9_-]{43})$/.exec(hash || '');
  return m ? { path: m[1], secret: m[2] } : null;
}
export async function makeKeys(path, secretB64u) {
  const base = await subtle.importKey('raw', unb64u(secretB64u), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hk = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(path), info: enc.encode(info) });
  const aes = await subtle.deriveKey(hk('desk-aes-v1'), base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const nameBits = await subtle.deriveBits(hk('desk-names-v1'), base, 256);
  const names = await subtle.importKey('raw', nameBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const apiBits = new Uint8Array(await subtle.deriveBits(hk('desk-api-v1'), base, 256));   // the desk API bearer (api.py _derived)
  const apiToken = btoa(String.fromCharCode(...apiBits)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { path, aes, names, apiToken };
}
export async function openBlob(keys, logicalName, buf) {
  const b = new Uint8Array(buf);
  if (b.length < 32 || String.fromCharCode(...b.slice(0, 4)) !== 'DSK1') throw new Error('bad file');
  return subtle.decrypt({ name: 'AES-GCM', iv: b.slice(4, 16), additionalData: enc.encode(logicalName) }, keys.aes, b.slice(16));
}
export async function coinFile(keys, mint) {
  const sig = new Uint8Array(await subtle.sign('HMAC', keys.names, enc.encode(mint)));
  return [...sig].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
export const FILES = { 'state.json': 'state.bin', 'chart.json': 'chart.bin', 'activity.json': 'activity.bin', 'screen.jpg': 'screen.bin',
  'bots.json': 'bots.bin', 'audit.json': 'audit.bin', 'account.json': 'account.bin' };
