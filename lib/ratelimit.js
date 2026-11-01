'use strict';

/** Límite de peticiones en memoria (ventana deslizante). Suficiente para una sola réplica. */
function createLimiter({ enabled = true } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (!v.some((t) => now - t < v.windowMs)) hits.delete(k);
  }, 60_000);
  timer.unref();

  const prune = (arr, windowMs, now) => {
    while (arr.length && now - arr[0] >= windowMs) arr.shift();
    return arr;
  };
  const entry = (key, windowMs) => {
    let e = hits.get(key);
    if (!e) hits.set(key, (e = Object.assign([], { windowMs })));
    e.windowMs = windowMs;
    return e;
  };

  return {
    /** Cuenta una petición; { ok:false, retry } si supera el límite. */
    take(key, limit, windowMs) {
      if (!enabled) return { ok: true };
      const now = Date.now();
      const e = prune(entry(key, windowMs), windowMs, now);
      if (e.length >= limit) return { ok: false, retry: Math.max(1, Math.ceil((e[0] + windowMs - now) / 1000)) };
      e.push(now);
      return { ok: true };
    },
    /** Bloqueo por intentos fallidos: consulta sin contar… */
    blocked(key, limit, windowMs) {
      if (!enabled) return { ok: true };
      const now = Date.now();
      const e = prune(entry(key, windowMs), windowMs, now);
      return e.length >= limit ? { ok: false, retry: Math.max(1, Math.ceil((e[0] + windowMs - now) / 1000)) } : { ok: true };
    },
    /** …y registro del fallo. */
    fail(key, windowMs) {
      if (enabled) entry(key, windowMs).push(Date.now());
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // el último salto lo añade el proxy de confianza
  }
  return req.socket.remoteAddress || 'unknown';
}

module.exports = { createLimiter, clientIp };
