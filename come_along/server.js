'use strict';
/**
 * Cuenta compartida — monolito (Node 22 + SQLite embebido, sin dependencias).
 *
 * Flujo:  /admin  ->  /cumplimentado  ->  /company
 * Estados del evento: setup -> honoree -> open -> closed
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cuenta.db');
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const CURRENCY = process.env.CURRENCY || 'COP';
const LOCALE = process.env.LOCALE || 'es-CO';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ DB */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  tip_percent REAL    NOT NULL DEFAULT 10 CHECK (tip_percent >= 0 AND tip_percent <= 100),
  status      TEXT    NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','honoree','open','closed')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS honoree_items (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  qty     INTEGER NOT NULL CHECK (qty > 0)
);
CREATE TABLE IF NOT EXISTS guests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  subtotal      INTEGER NOT NULL,
  tip_share     INTEGER NOT NULL,
  honoree_share INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS guest_items (
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES items(id)  ON DELETE CASCADE,
  qty      INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (guest_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_items_event  ON items(event_id);
CREATE INDEX IF NOT EXISTS idx_guests_event ON guests(event_id);
`);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------------------------------------------ Dominio */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const currentEvent = () => db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get() || null;

/** Ítems del evento con cantidades ya tomadas (cumplimentado / invitados). */
function loadPricing(ev) {
  const items = db
    .prepare(
      `SELECT i.id, i.name, i.unit_price AS price, i.qty,
              COALESCE(h.qty, 0) AS honoreeQty,
              COALESCE((SELECT SUM(gi.qty) FROM guest_items gi WHERE gi.item_id = i.id), 0) AS guestsQty
         FROM items i
         LEFT JOIN honoree_items h ON h.item_id = i.id
        WHERE i.event_id = ?
        ORDER BY i.position, i.id`
    )
    .all(ev.id)
    .map((i) => ({ ...i, available: i.qty - i.honoreeQty - i.guestsQty }));

  const S = items.reduce((a, i) => a + i.price * i.qty, 0); // subtotal de la factura
  const H = items.reduce((a, i) => a + i.price * i.honoreeQty, 0); // consumo del cumplimentado
  const T = Math.round((S * ev.tip_percent) / 100); // propina total
  const Sg = S - H; // consumo de quienes pagan
  return { items, S, H, T, Sg, tipPercent: ev.tip_percent };
}

/**
 * Total de un invitado = su consumo c
 *   + c/Sg * T   (su parte de la propina)
 *   + c/Sg * H   (su parte de lo consumido por el cumplimentado)
 * Aritmética entera; el redondeo es al peso más cercano.
 */
function computeQuote(p, selection) {
  const byId = new Map(p.items.map((i) => [i.id, i]));
  const lines = [];
  let c = 0;
  for (const [itemId, qty] of selection) {
    const it = byId.get(itemId);
    const amount = it.price * qty;
    c += amount;
    lines.push({ itemId, name: it.name, qty, unitPrice: it.price, amount });
  }
  const tipShare = p.Sg > 0 ? Math.round((c * p.T) / p.Sg) : 0;
  const honoreeShare = p.Sg > 0 ? Math.round((c * p.H) / p.Sg) : 0;
  return {
    lines,
    subtotal: c,
    tipPercent: p.tipPercent,
    tipShare,
    honoreeShare,
    total: c + tipShare + honoreeShare,
    sharePercent: p.Sg > 0 ? Math.round((c / p.Sg) * 10000) / 100 : 0,
  };
}

function normalizeSelection(raw, items, limitFn) {
  if (!Array.isArray(raw)) throw new HttpError(400, 'Selección inválida.');
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map();
  for (const row of raw) {
    const id = Number(row && row.itemId);
    const qty = Number(row && row.qty);
    if (!Number.isInteger(id) || !byId.has(id)) throw new HttpError(400, 'Ítem inválido.');
    if (!Number.isInteger(qty) || qty < 0) throw new HttpError(400, 'Cantidad inválida.');
    if (qty === 0) continue;
    out.set(id, (out.get(id) || 0) + qty);
  }
  for (const [id, qty] of out) {
    const it = byId.get(id);
    const max = limitFn(it);
    if (qty > max) {
      throw new HttpError(
        409,
        max <= 0
          ? `"${it.name}" ya no tiene unidades disponibles.`
          : `De "${it.name}" solo quedan ${max} disponible(s).`
      );
    }
  }
  return out;
}

function validateEventPayload(body) {
  const name = String((body && body.name) || '').trim() || 'Cuenta';
  if (name.length > 80) throw new HttpError(400, 'El nombre es demasiado largo (máx. 80).');
  const tip = Number(body && body.tipPercent);
  if (!Number.isFinite(tip) || tip < 0 || tip > 100) {
    throw new HttpError(400, 'La propina debe estar entre 0 y 100 %.');
  }
  const rawItems = body && body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, 'Agrega al menos un ítem.');
  }
  if (rawItems.length > 200) throw new HttpError(400, 'Demasiados ítems (máx. 200).');
  const items = rawItems.map((r, idx) => {
    const n = String((r && r.name) || '').trim();
    const price = Number(r && r.price);
    const qty = Number(r && r.qty);
    if (!n || n.length > 80) throw new HttpError(400, `Ítem ${idx + 1}: nombre inválido.`);
    if (!Number.isInteger(price) || price < 0 || price > 1e9) {
      throw new HttpError(400, `"${n}": el valor debe ser un entero mayor o igual a 0.`);
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      throw new HttpError(400, `"${n}": la cantidad debe ser un entero entre 1 y 1000.`);
    }
    return { name: n, price, qty };
  });
  return { name, tipPercent: Math.round(tip * 100) / 100, items };
}

function insertItems(eventId, items) {
  const ins = db.prepare('INSERT INTO items (event_id, name, unit_price, qty, position) VALUES (?,?,?,?,?)');
  items.forEach((i, idx) => ins.run(eventId, i.name, i.price, i.qty, idx));
}

/* ----------------------------------------------------------- Handlers */

const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });

route('GET', '/api/config', () => ({ currency: CURRENCY, locale: LOCALE }));

/* ---- Admin ---- */

function adminState() {
  const ev = currentEvent();
  if (!ev) return { event: null };
  const p = loadPricing(ev);
  const guests = db
    .prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY id')
    .all(ev.id)
    .map((g) => ({
      id: g.id,
      name: g.name,
      subtotal: g.subtotal,
      tipShare: g.tip_share,
      honoreeShare: g.honoree_share,
      total: g.total,
      createdAt: g.created_at,
    }));
  const collected = guests.reduce((a, g) => a + g.total, 0);
  return {
    event: { id: ev.id, name: ev.name, tipPercent: ev.tip_percent, status: ev.status, createdAt: ev.created_at },
    items: p.items,
    guests,
    summary: {
      subtotal: p.S,
      tip: p.T,
      invoiceTotal: p.S + p.T,
      honoreeConsumption: p.H,
      payersConsumption: p.Sg,
      collected,
      pending: p.S + p.T - collected,
    },
  };
}

route('GET', '/api/admin/state', () => adminState(), { admin: true });

route(
  'POST',
  '/api/admin/event',
  ({ body }) => {
    const data = validateEventPayload(body);
    tx(() => {
      db.prepare("UPDATE events SET status = 'closed' WHERE status != 'closed'").run();
      const r = db.prepare('INSERT INTO events (name, tip_percent) VALUES (?, ?)').run(data.name, data.tipPercent);
      insertItems(Number(r.lastInsertRowid), data.items);
    });
    return adminState();
  },
  { admin: true }
);

route(
  'PUT',
  '/api/admin/event',
  ({ body }) => {
    const data = validateEventPayload(body);
    tx(() => {
      const ev = currentEvent();
      if (!ev) throw new HttpError(404, 'No hay una cuenta creada.');
      if (ev.status !== 'setup') throw new HttpError(409, 'La cuenta ya fue habilitada; no se puede editar.');
      db.prepare('UPDATE events SET name = ?, tip_percent = ? WHERE id = ?').run(data.name, data.tipPercent, ev.id);
      db.prepare('DELETE FROM items WHERE event_id = ?').run(ev.id);
      insertItems(ev.id, data.items);
    });
    return adminState();
  },
  { admin: true }
);

route(
  'POST',
  '/api/admin/event/publish',
  () => {
    tx(() => {
      const ev = currentEvent();
      if (!ev) throw new HttpError(404, 'No hay una cuenta creada.');
      if (ev.status !== 'setup') throw new HttpError(409, 'La cuenta ya fue habilitada.');
      const n = db.prepare('SELECT COUNT(*) AS n FROM items WHERE event_id = ?').get(ev.id).n;
      if (n === 0) throw new HttpError(400, 'Agrega al menos un ítem.');
      db.prepare("UPDATE events SET status = 'honoree' WHERE id = ?").run(ev.id);
    });
    return adminState();
  },
  { admin: true }
);

route(
  'POST',
  '/api/admin/event/unpublish',
  () => {
    tx(() => {
      const ev = currentEvent();
      if (!ev || ev.status !== 'honoree') {
        throw new HttpError(409, 'Solo se puede volver a editar antes de que el cumplimentado registre su consumo.');
      }
      db.prepare("UPDATE events SET status = 'setup' WHERE id = ?").run(ev.id);
    });
    return adminState();
  },
  { admin: true }
);

route(
  'POST',
  '/api/admin/event/close',
  () => {
    tx(() => {
      const ev = currentEvent();
      if (!ev || ev.status === 'setup' || ev.status === 'closed') {
        throw new HttpError(409, 'No hay un cobro activo para cerrar.');
      }
      db.prepare("UPDATE events SET status = 'closed' WHERE id = ?").run(ev.id);
    });
    return adminState();
  },
  { admin: true }
);

route(
  'DELETE',
  '/api/admin/guests/(\\d+)',
  ({ params }) => {
    const ev = currentEvent();
    if (!ev) throw new HttpError(404, 'No hay una cuenta creada.');
    if (ev.status === 'closed') throw new HttpError(409, 'El cobro está cerrado.');
    const r = db.prepare('DELETE FROM guests WHERE id = ? AND event_id = ?').run(Number(params[0]), ev.id);
    if (r.changes === 0) throw new HttpError(404, 'Registro no encontrado.');
    return adminState();
  },
  { admin: true }
);

/* ---- Cumplimentado (nunca expone precios ni propina) ---- */

route('GET', '/api/honoree', () => {
  const ev = currentEvent();
  if (!ev) return { status: 'none' };
  if (ev.status === 'setup') return { status: 'setup', eventName: ev.name };
  const p = loadPricing(ev);
  return {
    status: ev.status,
    eventName: ev.name,
    items: p.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, selected: i.honoreeQty })),
  };
});

route('POST', '/api/honoree', ({ body }) => {
  return tx(() => {
    const ev = currentEvent();
    if (!ev || ev.status !== 'honoree') {
      throw new HttpError(409, 'Esta cuenta no está esperando el consumo del cumplimentado.');
    }
    const p = loadPricing(ev);
    const sel = normalizeSelection(body && body.selection, p.items, (it) => it.qty);
    const ins = db.prepare('INSERT INTO honoree_items (item_id, qty) VALUES (?, ?)');
    for (const [itemId, qty] of sel) ins.run(itemId, qty);
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(ev.id);
    return { status: 'open', saved: sel.size };
  });
});

/* ---- Invitados ---- */

route('GET', '/api/company', () => {
  const ev = currentEvent();
  if (!ev) return { status: 'none' };
  if (ev.status !== 'open') return { status: ev.status, eventName: ev.name };
  const p = loadPricing(ev);
  return {
    status: 'open',
    eventName: ev.name,
    tipPercent: ev.tip_percent,
    items: p.items.map((i) => ({ id: i.id, name: i.name, price: i.price, available: i.available })),
  };
});

function openEventOrThrow() {
  const ev = currentEvent();
  if (!ev || ev.status !== 'open') throw new HttpError(409, 'El cobro todavía no está habilitado o ya fue cerrado.');
  return ev;
}

function requireNonEmpty(sel) {
  if (sel.size === 0) throw new HttpError(400, 'Selecciona al menos un ítem.');
}

route('POST', '/api/company/quote', ({ body }) => {
  const ev = openEventOrThrow();
  const p = loadPricing(ev);
  const sel = normalizeSelection(body && body.selection, p.items, (it) => it.available);
  requireNonEmpty(sel);
  return { breakdown: computeQuote(p, sel) };
});

route('POST', '/api/company/guests', ({ body }) => {
  const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Escribe tu nombre.');
  if (name.length > 60) throw new HttpError(400, 'El nombre es demasiado largo (máx. 60).');
  return tx(() => {
    const ev = openEventOrThrow();
    const p = loadPricing(ev);
    const sel = normalizeSelection(body && body.selection, p.items, (it) => it.available);
    requireNonEmpty(sel);
    const dup = db
      .prepare('SELECT 1 AS x FROM guests WHERE event_id = ? AND lower(name) = lower(?)')
      .get(ev.id, name);
    if (dup) throw new HttpError(409, 'Ya hay un registro con ese nombre. Agrega tu apellido o una inicial.');
    const b = computeQuote(p, sel);
    const r = db
      .prepare('INSERT INTO guests (event_id, name, subtotal, tip_share, honoree_share, total) VALUES (?,?,?,?,?,?)')
      .run(ev.id, name, b.subtotal, b.tipShare, b.honoreeShare, b.total);
    const gid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO guest_items (guest_id, item_id, qty) VALUES (?,?,?)');
    for (const [itemId, qty] of sel) ins.run(gid, itemId, qty);
    return { guest: { id: gid, name }, breakdown: b };
  });
});

/* ------------------------------------------------------------- HTTP */

const PAGES = {
  '/admin': 'admin.html',
  '/cumplimentado': 'cumplimentado.html',
  '/company': 'company.html',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sha(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function isAdmin(req) {
  if (!ADMIN_PIN) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return crypto.timingSafeEqual(sha(pass), sha(ADMIN_PIN));
}

function deny(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Administrador", charset="UTF-8"',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify({ error: 'Se requiere el PIN de administrador.' }));
}

function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Solicitud demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    if (r.admin && !isAdmin(req)) return deny(res);
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
    return sendJson(res, 200, await r.handler({ body, params: m.slice(1) }));
  }
  const known = routes.some((r) => r.re.test(pathname));
  throw new HttpError(known ? 405 : 404, known ? 'Método no permitido.' : 'No encontrado.');
}

function serveFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'No encontrado.' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': cache,
    });
    res.end(data);
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Método no permitido.' });
  if (pathname === '/') {
    res.writeHead(302, { Location: '/company' });
    return res.end();
  }
  if (PAGES[pathname]) {
    if (pathname === '/admin' && !isAdmin(req)) return deny(res);
    return serveFile(res, path.join(PUBLIC_DIR, PAGES[pathname]), 'no-cache');
  }
  if (pathname.startsWith('/assets/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(path.join(PUBLIC_DIR, 'assets') + path.sep)) {
      return sendJson(res, 404, { error: 'No encontrado.' });
    }
    return serveFile(res, file, 'no-cache');
  }
  return sendJson(res, 404, { error: 'No encontrado.' });
}

const server = http.createServer(async (req, res) => {
  baseHeaders(res);
  try {
    const { pathname: raw } = new URL(req.url, 'http://localhost');
    const pathname = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: 'Error interno del servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`Cuenta compartida escuchando en http://localhost:${PORT}`);
  console.log(`  Admin:          http://localhost:${PORT}/admin${ADMIN_PIN ? '  (protegido con ADMIN_PIN)' : ''}`);
  console.log(`  Cumplimentado:  http://localhost:${PORT}/cumplimentado`);
  console.log(`  Invitados:      http://localhost:${PORT}/company`);
});
