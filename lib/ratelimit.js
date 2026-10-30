'use strict';

/** Límite de peticiones en memoria (ventana deslizante). Suficiente para una sola réplica. */
function createLimiter({ enabled = true } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (!v.some((t) => now - t < v.windowMs)) hits.delete(k);
  }, 60_000);
  timer.unref();

  return {
    /** Cuenta una petición; { ok:false, retry } si supera el límite. */
    take(key, limit, windowMs) {
      if (!enabled) return { ok: true };
      const now = Date.now();
      let e = hits.get(key);
      if (!e) hits.set(key, (e = Object.assign([], { windowMs })));
      e.windowMs = windowMs;
      while (e.length && now - e[0] >= windowMs) e.shift();
      if (e.length >= limit) return { ok: false, retry: Math.max(1, Math.ceil((e[0] + windowMs - now) / 1000)) };
      e.push(now);
      return { ok: true };
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
