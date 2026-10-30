'use strict';
/**
 * Come Along / Cuenta compartida — monolito (Node + PostgreSQL), sin autenticación de usuarios.
 *
 * Enlaces:   /admin  ·  /cumplimentado?t=TOKEN  ·  /company?t=TOKEN   (un token por cuenta y rol)
 * Estados:   setup -> honoree -> open -> closed   (honoree se omite si no hay exentos ni invitados)
 * Reglas:    v2 (cuentas nuevas) y v1 (históricas, solo lectura/continuación).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createDb, newToken } = require('./lib/db');
const { calcularCuota, cuotaProporcional } = require('./lib/split');
const { createLimiter, clientIp } = require('./lib/ratelimit');

/* --------------------------------------------------------------- Config */

const NODE_ENV = process.env.NODE_ENV || 'development';
const PROD = NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const CURRENCY = process.env.CURRENCY || 'COP';
const LOCALE = process.env.LOCALE || 'es-CO';
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : PROD;
const RATE_LIMIT = process.env.RATE_LIMIT !== 'off';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ID = 2147483647; // INTEGER de PostgreSQL

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT inválido');

const database = createDb();
const db = database; // fuera de transacciones: db.all / db.get / db.run
const tx = database.tx; // dentro: tx(async (q) => { ... q.all / q.get / q.run ... })
const limiter = createLimiter({ enabled: RATE_LIMIT });

const iso = (d) => (d ? new Date(d).toISOString() : null);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* -------------------------------------------------------------- Dominio */

/** Lee una cuenta; con `lock` la bloquea hasta el fin de la transacción (serializa los cambios de esa cuenta). */
async function eventById(q, id, { lock = false } = {}) {
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ID) throw new HttpError(404, 'Cuenta no encontrada.');
  const ev = await q.get(`SELECT * FROM events WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!ev) throw new HttpError(404, 'Cuenta no encontrada.');
  return ev;
}

async function eventByToken(q, kind, query) {
  const t = query.get('t') || '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) return null;
  const col = kind === 'honoree' ? 'honoree_token' : 'company_token';
  return (await q.get(`SELECT * FROM events WHERE ${col} = $1`, [t])) || null;
}

/** Fotografía completa de una cuenta: ítems con unidades tomadas, personas y totales. */
async function loadModel(q, ev) {
  const v2 = ev.rules_version === 2;
  const items = (
    await q.all(
      `SELECT i.id, i.name, i.unit_price AS price, i.qty, i.is_tip,
              COALESCE((SELECT SUM(pi.qty) FROM person_items pi WHERE pi.item_id = i.id), 0) AS people_qty,
              COALESCE((SELECT SUM(gi.qty) FROM guest_items gi WHERE gi.item_id = i.id), 0) AS guests_qty
         FROM items i WHERE i.event_id = $1 ORDER BY i.sort_order, i.id`,
      [ev.id]
    )
  ).map((i) => ({
    id: i.id, name: i.name, price: i.price, qty: i.qty, isTip: i.is_tip,
    peopleQty: i.people_qty, guestsQty: i.guests_qty,
    available: i.is_tip ? 0 : i.qty - i.people_qty - i.guests_qty,
  }));
  const people = (
    await q.all(
      `SELECT p.id, p.name, p.kind, p.registered_at,
              COALESCE(SUM(pi.qty * i.unit_price), 0) AS consumption
         FROM people p
         LEFT JOIN person_items pi ON pi.person_id = p.id
         LEFT JOIN items i ON i.id = pi.item_id
        WHERE p.event_id = $1 GROUP BY p.id ORDER BY p.sort_order, p.id`,
      [ev.id]
    )
  ).map((p) => ({ id: p.id, name: p.name, kind: p.kind, registeredAt: p.registered_at, consumption: p.consumption }));

  const S = items.filter((i) => !i.isTip).reduce((a, i) => a + i.price * i.qty, 0); // consumos (sin propina)
  const T = items.filter((i) => i.isTip).reduce((a, i) => a + i.price * i.qty, 0); // propina manual
  const E = people.filter((p) => p.kind === 'exempt').reduce((a, p) => a + p.consumption, 0);
  const G = people.filter((p) => p.kind === 'guest').reduce((a, p) => a + p.consumption, 0);
  const tipTotal = v2 ? T : Math.round((S * ev.tip_percent) / 100);
  return {
    ev, v2, items, people, S, E, G, tipTotal,
    peopleConsumption: E + G,
    shared: tipTotal + E + G, // v2: lo que se reparte en partes iguales
    payers: ev.payers_count,
    invoiceTotal: S + tipTotal,
    payersConsumption: S - E - G,
  };
}

/** Desglose de lo que paga un participante que consumió `selection` (Map itemId -> qty). */
function computeQuote(m, selection) {
  const byId = new Map(m.items.map((i) => [i.id, i]));
  const lines = [];
  let c = 0;
  for (const [itemId, qty] of selection) {
    const it = byId.get(itemId);
    const amount = it.price * qty;
    c += amount;
    lines.push({ itemId, name: it.name, qty, unitPrice: it.price, amount });
  }
  if (m.v2) {
    let q;
    try {
      q = calcularCuota({ consumo: c, compartido: m.shared, pagadores: m.payers });
    } catch (err) {
      throw new HttpError(409, err.message);
    }
    const tipShare = Math.floor(m.tipTotal / m.payers);
    const othersShare = Math.floor((m.E + m.G) / m.payers);
    return {
      kind: 'v2', lines, subtotal: c, payers: m.payers,
      tipShare, othersShare, adjustment: q.total - c - tipShare - othersShare,
      total: q.total, exact: q.exacto, roundingDiff: q.diferencia,
    };
  }
  const r = cuotaProporcional({
    consumo: c, consumoPagadores: m.payersConsumption, propina: m.tipTotal, consumoExentos: m.peopleConsumption,
  });
  return {
    kind: 'v1', lines, subtotal: c, tipPercent: m.ev.tip_percent,
    tipShare: r.tipShare, honoreeShare: r.honoreeShare, total: r.total, exact: r.total, roundingDiff: 0,
    sharePercent: m.payersConsumption > 0 ? Math.round((c / m.payersConsumption) * 10000) / 100 : 0,
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
    if (byId.get(id).isTip) throw new HttpError(400, 'Ítem inválido.');
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
        max <= 0 ? `"${it.name}" ya no tiene unidades disponibles.` : `De "${it.name}" solo quedan ${max} disponible(s).`
      );
    }
  }
  return out;
}

const cleanName = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

function validateEventPayload(body) {
  const b = body || {};
  const name = cleanName(b.name) || 'Cuenta';
  if (name.length > 80) throw new HttpError(400, 'El nombre es demasiado largo (máx. 80).');
  const payersCount = Number(b.payersCount);
  if (!Number.isInteger(payersCount) || payersCount < 0 || payersCount > 500) {
    throw new HttpError(400, 'El número de participantes que pagan debe ser un entero entre 0 y 500.');
  }
  const seen = new Set();
  const people = [];
  for (const [key, kind, label] of [['exempt', 'exempt', 'exentos'], ['guests', 'guest', 'invitados']]) {
    const arr = b[key] == null ? [] : b[key];
    if (!Array.isArray(arr) || arr.length > 50) throw new HttpError(400, `Lista de ${label} inválida (máx. 50).`);
    for (const raw of arr) {
      const n = cleanName(raw);
      if (!n) continue;
      if (n.length > 60) throw new HttpError(400, `Nombre demasiado largo en ${label} (máx. 60).`);
      const k = n.toLowerCase();
      if (seen.has(k)) throw new HttpError(400, `"${n}" está repetido entre exentos e invitados.`);
      seen.add(k);
      people.push({ name: n, kind });
    }
  }
  const rawItems = b.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, 'Agrega al menos un ítem.');
  if (rawItems.length > 200) throw new HttpError(400, 'Demasiados ítems (máx. 200).');
  const items = rawItems.map((r, idx) => {
    const n = cleanName(r && r.name);
    const price = Number(r && r.price);
    const qty = Number(r && r.qty);
    if (!n || n.length > 80) throw new HttpError(400, `Ítem ${idx + 1}: nombre inválido.`);
    if (!Number.isInteger(price) || price < 0 || price > 1e9) {
      throw new HttpError(400, `"${n}": el valor debe ser un entero mayor o igual a 0.`);
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      throw new HttpError(400, `"${n}": la cantidad debe ser un entero entre 1 y 1000.`);
    }
    let id = null;
    if (r.id != null) {
      id = Number(r.id);
      if (!Number.isInteger(id) || id < 1 || id > MAX_ID) throw new HttpError(400, `"${n}": identificador inválido.`);
    }
    return { id, name: n, price, qty, isTip: r.isTip === true };
  });
  if (!items.some((i) => !i.isTip)) throw new HttpError(400, 'Agrega al menos un ítem de consumo (no propina).');
  return { name, payersCount, people, items };
}

async function insertPeople(q, eventId, people) {
  for (const [idx, p] of people.entries()) {
    await q.run('INSERT INTO people (event_id, name, kind, sort_order) VALUES ($1,$2,$3,$4)', [eventId, p.name, p.kind, idx]);
  }
}

const INSERT_ITEM = 'INSERT INTO items (event_id, name, unit_price, qty, is_tip, sort_order) VALUES ($1,$2,$3,$4,$5,$6)';

function createEvent(data) {
  return tx(async (q) => {
    const { id } = await q.get(
      `INSERT INTO events (name, tip_percent, rules_version, payers_count, company_token, honoree_token)
       VALUES ($1, 0, 2, $2, $3, $4) RETURNING id`,
      [data.name, data.payersCount, newToken(), newToken()]
    );
    for (const [idx, i] of data.items.entries()) await q.run(INSERT_ITEM, [id, i.name, i.price, i.qty, i.isTip, idx]);
    await insertPeople(q, id, data.people);
    return id;
  });
}

const claimedUnits = async (q, itemId) =>
  (
    await q.get(
      `SELECT COALESCE((SELECT SUM(qty) FROM person_items WHERE item_id = $1), 0)
            + COALESCE((SELECT SUM(qty) FROM guest_items  WHERE item_id = $1), 0) AS n`,
      [itemId]
    )
  ).n;

/** Recalcula las cuotas guardadas tras editar la cuenta. Rechaza si cambiaría una cuota ya pagada. */
async function recomputeGuests(q, evId) {
  const m = await loadModel(q, await eventById(q, evId));
  const guests = await q.all('SELECT id, name, total, paid_at FROM guests WHERE event_id = $1', [evId]);
  let changed = 0;
  for (const g of guests) {
    const rows = await q.all('SELECT item_id, qty FROM guest_items WHERE guest_id = $1', [g.id]);
    const b = computeQuote(m, new Map(rows.map((r) => [r.item_id, r.qty])));
    if (b.total !== g.total) {
      if (g.paid_at) {
        throw new HttpError(409, `El cambio modificaría la cuota de ${g.name}, que ya está marcada como pagada. Desmarca el pago primero.`);
      }
      changed++;
    }
    await q.run(
      'UPDATE guests SET subtotal=$1, tip_share=$2, honoree_share=$3, total=$4, calc_exact=$5, rounding_diff=$6 WHERE id=$7',
      [b.subtotal, b.tipShare, b.kind === 'v2' ? b.othersShare : b.honoreeShare, b.total, b.exact, b.roundingDiff, g.id]
    );
  }
  return changed;
}

/** Guarda cambios. En setup reemplaza todo; después fusiona ítems por id y recalcula las cuotas. */
function saveEvent(id, data) {
  return tx(async (q) => {
    const ev = await eventById(q, id, { lock: true });
    if (ev.status === 'closed') throw new HttpError(409, 'La cuenta está cerrada; no se puede editar.');
    if (ev.rules_version !== 2) {
      throw new HttpError(409, 'Las cuentas históricas (propina porcentual) no se pueden editar.');
    }
    if (ev.status !== 'setup') {
      const registered = (await q.get('SELECT COUNT(*) AS n FROM guests WHERE event_id = $1', [id])).n;
      if (data.payersCount < registered) {
        throw new HttpError(409, `Ya hay ${registered} participante(s) registrados; el número de pagadores no puede ser menor.`);
      }
    }
    const existing = await q.all('SELECT id, name FROM items WHERE event_id = $1', [id]);
    const keep = new Set();
    for (const [idx, it] of data.items.entries()) {
      if (it.id == null) {
        await q.run(INSERT_ITEM, [id, it.name, it.price, it.qty, it.isTip, idx]);
        continue;
      }
      if (!existing.some((e) => e.id === it.id)) throw new HttpError(400, `"${it.name}": ítem desconocido.`);
      keep.add(it.id);
      const n = await claimedUnits(q, it.id);
      if (it.qty < n) throw new HttpError(409, `"${it.name}": ya hay ${n} unidad(es) tomada(s); la cantidad no puede ser menor.`);
      if (it.isTip && n > 0) throw new HttpError(409, `"${it.name}" ya tiene consumos registrados y no puede marcarse como propina.`);
      await q.run(
        'UPDATE items SET name=$1, unit_price=$2, qty=$3, is_tip=$4, sort_order=$5 WHERE id=$6 AND event_id=$7',
        [it.name, it.price, it.qty, it.isTip, idx, it.id, id]
      );
    }
    for (const ex of existing) {
      if (keep.has(ex.id)) continue;
      if ((await claimedUnits(q, ex.id)) > 0) throw new HttpError(409, `No puedes quitar "${ex.name}" porque ya tiene consumos registrados.`);
      await q.run('DELETE FROM items WHERE id = $1', [ex.id]);
    }
    await q.run('UPDATE events SET name = $1, payers_count = $2 WHERE id = $3', [data.name, data.payersCount, id]);
    let changed = 0;
    if (ev.status === 'setup') {
      await q.run('DELETE FROM people WHERE event_id = $1', [id]);
      await insertPeople(q, id, data.people);
    } else if (ev.status === 'open') {
      changed = await recomputeGuests(q, id);
    }
    return { changed };
  });
}

/* --------------------------------------------------------------- Admin */

async function adminState(q, ev) {
  const m = await loadModel(q, ev);
  const gi = await q.all(
    `SELECT gi.guest_id AS gid, gi.qty, i.name FROM guest_items gi
       JOIN items i ON i.id = gi.item_id JOIN guests g ON g.id = gi.guest_id WHERE g.event_id = $1 ORDER BY i.sort_order, i.id`,
    [ev.id]
  );
  const guests = (await q.all('SELECT * FROM guests WHERE event_id = $1 ORDER BY id', [ev.id])).map((g) => ({
    id: g.id, name: g.name, subtotal: g.subtotal, tipShare: g.tip_share, othersShare: g.honoree_share,
    total: g.total, calcExact: g.calc_exact, roundingDiff: g.rounding_diff, paidAt: iso(g.paid_at), createdAt: iso(g.created_at),
    items: gi.filter((x) => x.gid === g.id).map((x) => ({ name: x.name, qty: x.qty })),
  }));
  const collected = guests.reduce((a, g) => a + g.total, 0);
  const paid = guests.filter((g) => g.paidAt).reduce((a, g) => a + g.total, 0);
  const unclaimed = m.items.filter((i) => !i.isTip);
  return {
    event: {
      id: ev.id, name: ev.name, status: ev.status, rulesVersion: ev.rules_version, payersCount: ev.payers_count,
      tipPercent: ev.rules_version === 1 ? ev.tip_percent : null, createdAt: iso(ev.created_at),
      links: { honoree: `/cumplimentado?t=${ev.honoree_token}`, company: `/company?t=${ev.company_token}` },
    },
    items: m.items,
    people: m.people.map((p) => ({ id: p.id, name: p.name, kind: p.kind, registered: !!p.registeredAt, consumption: p.consumption })),
    guests,
    summary: {
      invoiceTotal: m.invoiceTotal, consumptionTotal: m.S, tipTotal: m.tipTotal,
      exemptConsumption: m.E, guestConsumption: m.G, sharedTotal: m.shared,
      payersCount: ev.payers_count, payersRegistered: guests.length,
      sharePerPayer: ev.payers_count > 0 ? Math.round((m.shared / ev.payers_count) * 100) / 100 : 0,
      collected, paid, awaitingPayment: collected - paid,
      roundingDiff: Math.round(guests.reduce((a, g) => a + (g.roundingDiff || 0), 0) * 100) / 100,
      difference: collected - m.invoiceTotal,
      unclaimedUnits: unclaimed.reduce((a, i) => a + i.available, 0),
      unclaimedValue: unclaimed.reduce((a, i) => a + i.available * i.price, 0),
    },
  };
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyección de fórmulas en Excel/Sheets
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function exportCsv(ev) {
  const s = await adminState(db, ev);
  const head = ['Nombre', 'Ítems', 'Consumo', 'Parte de propina', 'Parte de exentos e invitados', 'Total a pagar',
    'Calculado sin redondeo', 'Diferencia por redondeo', 'Pagado', 'Registrado'];
  const rows = s.guests.map((g) => [
    g.name, g.items.map((i) => `${i.qty}x ${i.name}`).join(' | '), g.subtotal, g.tipShare, g.othersShare, g.total,
    g.calcExact, g.roundingDiff, g.paidAt ? 'Sí' : 'No', g.createdAt,
  ]);
  rows.push([], ['Total factura', '', '', '', '', s.summary.invoiceTotal], ['Recaudo registrado', '', '', '', '', s.summary.collected],
    ['Diferencia vs factura', '', '', '', '', s.summary.difference], ['Pagado', '', '', '', '', s.summary.paid]);
  return '\ufeff' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* -------------------------------------------------------------- Rutas */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
const idParam = (ctx, i = 0) => Number(ctx.params[i]);
const state = async (id) => adminState(db, await eventById(db, id));

route('GET', '/api/config', () => ({ currency: CURRENCY, locale: LOCALE }));

/* ---- Cuentas ---- */
route('GET', '/api/admin/events', async () => ({
  events: await db.all(
    `SELECT e.id, e.name, e.status, e.rules_version AS "rulesVersion", e.created_at AS "createdAt",
            (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) AS guests
       FROM events e ORDER BY e.id DESC LIMIT 200`
  ),
}));

route('POST', '/api/admin/events', async ({ body }) => state(await createEvent(validateEventPayload(body))));

route('GET', '/api/admin/events/(\\d+)', (ctx) => state(idParam(ctx)));

route('PUT', '/api/admin/events/(\\d+)', async (ctx) => {
  const id = idParam(ctx);
  const { changed } = await saveEvent(id, validateEventPayload(ctx.body));
  return { ...(await state(id)), recalculated: changed };
});

route('POST', '/api/admin/events/(\\d+)/publish', async (ctx) => {
  const id = idParam(ctx);
  await tx(async (q) => {
    const ev = await eventById(q, id, { lock: true });
    if (ev.status !== 'setup') throw new HttpError(409, 'La cuenta ya fue habilitada.');
    const m = await loadModel(q, ev);
    if (!m.items.some((i) => !i.isTip)) throw new HttpError(400, 'Agrega al menos un ítem de consumo.');
    if (ev.rules_version === 2 && ev.payers_count < 1) {
      throw new HttpError(400, 'Indica cuántos participantes pagan (al menos 1).');
    }
    const next = m.people.length ? 'honoree' : 'open';
    await q.run('UPDATE events SET status = $1 WHERE id = $2', [next, ev.id]);
  });
  return state(id);
});

route('POST', '/api/admin/events/(\\d+)/unpublish', async (ctx) => {
  const id = idParam(ctx);
  await tx(async (q) => {
    const ev = await eventById(q, id, { lock: true });
    const reg = (await q.get('SELECT COUNT(*) AS n FROM people WHERE event_id = $1 AND registered_at IS NOT NULL', [ev.id])).n;
    if (ev.status !== 'honoree' || reg > 0) {
      throw new HttpError(409, 'Solo se puede volver a editar antes de que alguien registre su consumo.');
    }
    await q.run("UPDATE events SET status = 'setup' WHERE id = $1", [ev.id]);
  });
  return state(id);
});

route('POST', '/api/admin/events/(\\d+)/close', async (ctx) => {
  const id = idParam(ctx);
  await tx(async (q) => {
    const ev = await eventById(q, id, { lock: true });
    if (ev.status !== 'honoree' && ev.status !== 'open') throw new HttpError(409, 'No hay un cobro activo para cerrar.');
    const n = (await q.get('SELECT COUNT(*) AS n FROM guests WHERE event_id = $1', [ev.id])).n;
    if (ev.rules_version === 2 && n !== ev.payers_count && n !== 0) {
      throw new HttpError(409, `No se puede cerrar: hay ${n} de ${ev.payers_count} participantes registrados (cuotas pendientes de cálculo).`);
    }
    await q.run("UPDATE events SET status = 'closed' WHERE id = $1", [ev.id]);
  });
  return state(id);
});

route('POST', '/api/admin/events/(\\d+)/tokens/rotate', async (ctx) => {
  const id = idParam(ctx);
  await tx(async (q) => {
    const ev = await eventById(q, id, { lock: true });
    if (ev.status === 'closed') throw new HttpError(409, 'La cuenta está cerrada.');
    await q.run('UPDATE events SET company_token = $1, honoree_token = $2 WHERE id = $3', [newToken(), newToken(), ev.id]);
  });
  return state(id);
});

route('DELETE', '/api/admin/events/(\\d+)/guests/(\\d+)', async (ctx) => {
  const id = idParam(ctx);
  const gid = idParam(ctx, 1);
  await tx(async (q) => {
    const ev = await eventById(q, id, { lock: true });
    if (ev.status === 'closed') throw new HttpError(409, 'El cobro está cerrado.');
    const g = gid <= MAX_ID ? await q.get('SELECT paid_at FROM guests WHERE id = $1 AND event_id = $2', [gid, ev.id]) : null;
    if (!g) throw new HttpError(404, 'Registro no encontrado.');
    if (g.paid_at) throw new HttpError(409, 'Ese registro está marcado como pagado; desmarca el pago primero.');
    await q.run('DELETE FROM guests WHERE id = $1', [gid]);
  });
  return state(id);
});

route('POST', '/api/admin/events/(\\d+)/guests/(\\d+)/paid', async (ctx) => {
  const ev = await eventById(db, idParam(ctx));
  if (ev.status !== 'open' && ev.status !== 'closed') throw new HttpError(409, 'Aún no hay cobro activo.');
  const paid = ctx.body && ctx.body.paid === true;
  const gid = idParam(ctx, 1);
  const changes = gid <= MAX_ID
    ? await db.run('UPDATE guests SET paid_at = $1 WHERE id = $2 AND event_id = $3', [paid ? new Date() : null, gid, ev.id])
    : 0;
  if (changes === 0) throw new HttpError(404, 'Registro no encontrado.');
  return adminState(db, ev);
});

route('GET', '/api/admin/events/(\\d+)/export.csv', async (ctx) => {
  const ev = await eventById(db, idParam(ctx));
  const slug = ev.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cuenta';
  return {
    raw: true, status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug}-${ev.id}.csv"` },
    body: await exportCsv(ev),
  };
});

/* ---- Cumplimentado (exentos e invitados): nunca expone precios ni propina ---- */

route('GET', '/api/honoree', async ({ query }) => {
  const ev = await eventByToken(db, 'honoree', query);
  if (!ev) return { status: 'invalid' };
  if (ev.status === 'setup') return { status: 'setup', eventName: ev.name };
  const m = await loadModel(db, ev);
  return {
    status: ev.status,
    eventName: ev.name,
    people: m.people.map((p) => ({ id: p.id, name: p.name, kind: p.kind, registered: !!p.registeredAt })),
    items: m.items.filter((i) => !i.isTip).map((i) => ({ id: i.id, name: i.name, qty: i.qty, remaining: i.qty - i.peopleQty })),
  };
});

route('POST', '/api/honoree', ({ query, body }) =>
  tx(async (q) => {
    const found = await eventByToken(q, 'honoree', query);
    if (!found) throw new HttpError(404, 'Enlace inválido.');
    const ev = await eventById(q, found.id, { lock: true });
    if (ev.status !== 'honoree') throw new HttpError(409, 'Esta cuenta no está esperando consumos de exentos o invitados.');
    const m = await loadModel(q, ev);
    const pending = m.people.filter((p) => !p.registeredAt);
    let person;
    if (body && body.personId != null) person = m.people.find((p) => p.id === Number(body.personId));
    else if (pending.length === 1) person = pending[0];
    if (!person) throw new HttpError(400, 'Elige quién eres en la lista.');
    if (person.registeredAt) throw new HttpError(409, `${person.name} ya registró su consumo.`);
    const sel = normalizeSelection(body && body.selection, m.items, (it) => it.qty - it.peopleQty);
    for (const [itemId, qty] of sel) {
      await q.run('INSERT INTO person_items (person_id, item_id, qty) VALUES ($1, $2, $3)', [person.id, itemId, qty]);
    }
    await q.run('UPDATE people SET registered_at = now() WHERE id = $1', [person.id]);
    const left = pending.length - 1;
    if (left === 0) await q.run("UPDATE events SET status = 'open' WHERE id = $1", [ev.id]);
    return { status: left === 0 ? 'open' : 'honoree', pending: left };
  })
);

/* ---- Participantes que pagan ---- */

route('GET', '/api/company', async ({ query }) => {
  const ev = await eventByToken(db, 'company', query);
  if (!ev) return { status: 'invalid' };
  if (ev.status !== 'open') return { status: ev.status, eventName: ev.name };
  const m = await loadModel(db, ev);
  const registered = (await db.get('SELECT COUNT(*) AS n FROM guests WHERE event_id = $1', [ev.id])).n;
  return {
    status: 'open',
    rulesVersion: ev.rules_version,
    eventName: ev.name,
    tipPercent: ev.rules_version === 1 ? ev.tip_percent : null,
    payersCount: ev.payers_count,
    registered,
    items: m.items.filter((i) => !i.isTip).map((i) => ({ id: i.id, name: i.name, price: i.price, available: i.available })),
  };
});

async function openEventFor(q, query, { lock = false } = {}) {
  const found = await eventByToken(q, 'company', query);
  if (!found) throw new HttpError(404, 'Enlace inválido.');
  const ev = await eventById(q, found.id, { lock });
  if (ev.status !== 'open') throw new HttpError(409, 'El cobro todavía no está habilitado o ya fue cerrado.');
  return ev;
}

async function checkSlots(q, ev) {
  if (ev.rules_version !== 2) return;
  const n = (await q.get('SELECT COUNT(*) AS n FROM guests WHERE event_id = $1', [ev.id])).n;
  if (n >= ev.payers_count) throw new HttpError(409, 'Ya se registraron todos los participantes que pagan.');
}

const requireNonEmpty = (sel) => {
  if (sel.size === 0) throw new HttpError(400, 'Selecciona al menos un ítem.');
};

route('POST', '/api/company/quote', async ({ query, body }) => {
  const ev = await openEventFor(db, query);
  await checkSlots(db, ev);
  const m = await loadModel(db, ev);
  const sel = normalizeSelection(body && body.selection, m.items, (it) => it.available);
  requireNonEmpty(sel);
  return { breakdown: computeQuote(m, sel) };
});

route('POST', '/api/company/guests', async ({ query, body }) => {
  const name = cleanName(body && body.name);
  if (!name) throw new HttpError(400, 'Escribe tu nombre.');
  if (name.length > 60) throw new HttpError(400, 'El nombre es demasiado largo (máx. 60).');
  return tx(async (q) => {
    const ev = await openEventFor(q, query, { lock: true }); // la cuenta queda bloqueada: sin carreras por unidades ni cupos
    await checkSlots(q, ev);
    const m = await loadModel(q, ev);
    const sel = normalizeSelection(body && body.selection, m.items, (it) => it.available);
    requireNonEmpty(sel);
    const dup = await q.get('SELECT 1 AS x FROM guests WHERE event_id = $1 AND lower(name) = lower($2)', [ev.id, name]);
    if (dup) throw new HttpError(409, 'Ya hay un registro con ese nombre. Agrega tu apellido o una inicial.');
    const b = computeQuote(m, sel);
    const { id: gid } = await q.get(
      `INSERT INTO guests (event_id, name, subtotal, tip_share, honoree_share, total, calc_exact, rounding_diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ev.id, name, b.subtotal, b.tipShare, b.kind === 'v2' ? b.othersShare : b.honoreeShare, b.total, b.exact, b.roundingDiff]
    );
    for (const [itemId, qty] of sel) {
      await q.run('INSERT INTO guest_items (guest_id, item_id, qty) VALUES ($1,$2,$3)', [gid, itemId, qty]);
    }
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
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}

function sendJson(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
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

async function handleApi(req, res, pathname, query) {
  const ip = clientIp(req, TRUST_PROXY);
  const isAdminPath = pathname.startsWith('/api/admin/');
  const bucket = isAdminPath ? ['adm', 600] : req.method === 'GET' ? ['pubr', 240] : ['pubw', 40];
  const lim = limiter.take(`${bucket[0]}:${ip}`, bucket[1], 60_000);
  if (!lim.ok) throw Object.assign(new HttpError(429, 'Demasiadas solicitudes. Intenta de nuevo en un momento.'), { retry: lim.retry });

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
    const out = await r.handler({ req, res, body, query, ip, params: m.slice(1) });
    if (out && out.raw) {
      res.writeHead(out.status, { 'Cache-Control': 'no-store', ...out.headers });
      return res.end(out.body);
    }
    return sendJson(res, 200, out);
  }
  const known = routes.some((r) => r.re.test(pathname));
  throw new HttpError(known ? 405 : 404, known ? 'Método no permitido.' : 'No encontrado.');
}

function serveFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'No encontrado.' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Método no permitido.' });
  if (pathname === '/') {
    res.writeHead(302, { Location: '/admin' });
    return res.end();
  }
  if (PAGES[pathname]) {
    return serveFile(res, path.join(PUBLIC_DIR, PAGES[pathname]), 'no-cache');
  }
  if (pathname.startsWith('/assets/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(path.join(PUBLIC_DIR, 'assets') + path.sep)) return sendJson(res, 404, { error: 'No encontrado.' });
    return serveFile(res, file, 'no-cache');
  }
  return sendJson(res, 404, { error: 'No encontrado.' });
}

const server = http.createServer(async (req, res) => {
  baseHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    if (pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Método no permitido.' });
      try {
        await db.get('SELECT 1 AS ok');
      } catch (err) {
        console.error('Healthcheck: PostgreSQL no responde:', err.message);
        return sendJson(res, 503, { status: 'error' });
      }
      return sendJson(res, 200, { status: 'ok' });
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url.searchParams);
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: err.message }, err.retry ? { 'Retry-After': String(err.retry) } : {});
    }
    console.error(err);
    return sendJson(res, 500, { error: 'Error interno del servidor.' });
  }
});

async function main() {
  await database.init();
  server.listen(PORT, HOST, () => {
    console.log(`Come Along escuchando en http://${HOST}:${PORT} (${NODE_ENV}) · PostgreSQL conectado`);
  });
}

function shutdown() {
  server.close(async () => {
    try { await database.close(); } catch { /* ya cerrado */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => console.error('Promesa rechazada sin manejar:', err));

main().catch((err) => {
  console.error('No se pudo iniciar:', err.message);
  process.exit(1);
});
