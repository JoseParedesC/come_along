'use strict';
const crypto = require('node:crypto');

const COOKIE = 'ca_admin';
const TTL_MS = 12 * 3_600_000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Sesión de administrador: cookie HttpOnly firmada con HMAC (sin estado en servidor). */
function createAuth({ secret, secure }) {
  const enabled = !!secret;
  const key = sha(`session-key:${process.env.SESSION_SECRET || secret}`);
  const sign = (p) => crypto.createHmac('sha256', key).update(p).digest('base64url');

  function checkPassword(input) {
    return enabled && crypto.timingSafeEqual(sha(input), sha(secret));
  }
  function issue() {
    const exp = String(Date.now() + TTL_MS);
    return `${exp}.${sign(exp)}`;
  }
  function verify(token) {
    if (!token) return false;
    const [exp, sig] = String(token).split('.');
    if (!exp || !sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(exp) > Date.now();
  }
  function cookieFrom(req) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
  }
  const attrs = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return {
    enabled,
    isAuthed: (req) => !enabled || verify(cookieFrom(req)),
    checkPassword,
    setCookie: (res) => res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(issue())}; Max-Age=${TTL_MS / 1000}; ${attrs}`),
    clearCookie: (res) => res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${attrs}`),
  };
}

module.exports = { createAuth };
