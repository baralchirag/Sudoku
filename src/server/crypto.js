// HMAC-SHA256 primitives over WebCrypto (available in Workers and Node 20+).
//
// Sessions are stateless: the server hands out a signed token describing the
// game (puzzle id, start time, hints taken) and trusts nothing the client
// sends unless it comes back inside a valid signature.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map();

function importKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

export function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Raw HMAC digest of a message. */
export async function hmac(secret, message) {
  const key = await importKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Signs a JSON payload into "<payload>.<signature>", both base64url. */
export async function signToken(secret, payload) {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const sig = base64url(await hmac(secret, body));
  return `${body}.${sig}`;
}

/** Returns the payload of a valid token, or null. Verification is constant-time. */
export async function verifyToken(secret, token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  try {
    const key = await importKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, fromBase64url(token.slice(dot + 1)), encoder.encode(body));
    return ok ? JSON.parse(decoder.decode(fromBase64url(body))) : null;
  } catch {
    return null;
  }
}

export function randomId(bytes = 12) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
