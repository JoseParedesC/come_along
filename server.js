'use strict';
/**
 * Come Along / Cuenta compartida — monolito (Node 22 + SQLite embebido, sin dependencias).
 *
 * Enlaces:   /admin  ·  /cumplimentado?t=TOKEN  ·  /company?t=TOKEN   (un token por cuenta y rol)
 * Estados:   setup -> honoree -> open -> closed   (honoree se omite si no hay exentos ni invitados)
 * Reglas:    v2 (cuentas nuevas) y v1 (históricas, solo lectura/continuación).
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, newToken } = require('./lib/db');
const { calcularCuota, cuotaProporcional } = require('./lib/split');
const { createAuth } = require('./lib/auth');
const { createLimiter, clientIp } = require('./lib/ratelimit');
const backup = require('./lib/backup');
const { repartir } = require('./lib/settle');

/* --------------------------------------------------------------- Config */

const NODE_ENV = process.env.NODE_ENV || 'development';
const PROD = NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cuenta.db');
const ADMIN_SECRET = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN || '';
const CURRENCY = process.env.CURRENCY || 'COP';
const LOCALE = process.env.LOCALE || 'es-CO';
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : PROD;
const RATE_LIMIT = process.env.RATE_LIMIT !== 'off';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS ?? 6);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 14);
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT inválido');
if (PROD && ADMIN_SECRET.length < 10) {
  throw new Error('En producción ADMIN_PASSWORD (o ADMIN_PIN) es obligatorio y debe tener al menos 10 caracteres.');
}

const db = openDb(DB_PATH);
const auth = createAuth({ secret: ADMIN_SECRET, secure: PROD });
const limiter = createLimiter({ enabled: RATE_LIMIT });

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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* -------------------------------------------------------------- Dominio */

const eventById = (id) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) throw new HttpError(404, 'Cuenta no encontrada.');
  return ev;
};

function eventByToken(kind, query) {
  const t = query.get('t') || '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) return null;
  const col = kind === 'honoree' ? 'honoree_token' : 'company_token';
  return db.prepare(`SELECT * FROM events WHERE ${col} = ?`).get(t) || null;
}

/** Fotografía completa de una cuenta: ítems con unidades tomadas, personas y totales. */
function loadModel(ev) {
  const v2 = ev.rules_version === 2;
  const items = db
    .prepare(
      `SELECT i.id, i.name, i.unit_price AS price, i.qty, i.is_tip AS isTip,
              COALESCE((SELECT SUM(pi.qty) FROM person_items pi WHERE pi.item_id = i.id), 0) AS peopleQty,
              COALESCE((SELECT SUM(gi.qty) FROM guest_items gi WHERE gi.item_id = i.id), 0) AS guestsQty
         FROM items i WHERE i.event_id = ? ORDER BY i.position, i.id`
    )
    .all(ev.id)
    .map((i) => ({
      id: i.id, name: i.name, price: i.price, qty: i.qty, isTip: !!i.isTip,
      peopleQty: i.peopleQty, guestsQty: i.guestsQty,
      available: i.isTip ? 0 : i.qty - i.peopleQty - i.guestsQty,
    }));
  const people = db
    .prepare(
      `SELECT p.id, p.name, p.kind, p.registered_at AS registeredAt,
              COALESCE(SUM(pi.qty * i.unit_price), 0) AS consumption
         FROM people p
         LEFT JOIN person_items pi ON pi.person_id = p.id
         LEFT JOIN items i ON i.id = pi.item_id
        WHERE p.event_id = ? GROUP BY p.id ORDER BY p.position, p.id`
    )
    .all(ev.id);

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
      if (!Number.isInteger(id)) throw new HttpError(400, `"${n}": identificador inválido.`);
    }
    return { id, name: n, price, qty, isTip: r.isTip === true };
  });
  if (!items.some((i) => !i.isTip)) throw new HttpError(400, 'Agrega al menos un ítem de consumo (no propina).');
  return { name, payersCount, people, items };
}

function insertPeople(eventId, people) {
  const ins = db.prepare('INSERT INTO people (event_id, name, kind, position) VALUES (?,?,?,?)');
  people.forEach((p, idx) => ins.run(eventId, p.name, p.kind, idx));
}

function createEvent(data) {
  return tx(() => {
    const r = db
      .prepare(
        `INSERT INTO events (name, tip_percent, rules_version, payers_count, company_token, honoree_token)
         VALUES (?, 0, 2, ?, ?, ?)`
      )
      .run(data.name, data.payersCount, newToken(), newToken());
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO items (event_id, name, unit_price, qty, is_tip, position) VALUES (?,?,?,?,?,?)');
    data.items.forEach((i, idx) => ins.run(id, i.name, i.price, i.qty, i.isTip ? 1 : 0, idx));
    insertPeople(id, data.people);
    return id;
  });
}

const claimedUnits = (itemId) =>
  db
    .prepare(
      `SELECT COALESCE((SELECT SUM(qty) FROM person_items WHERE item_id = ?), 0)
            + COALESCE((SELECT SUM(qty) FROM guest_items  WHERE item_id = ?), 0) AS n`
    )
    .get(itemId, itemId).n;

/** Recalcula las cuotas guardadas tras editar la cuenta. Rechaza si cambiaría una cuota ya pagada. */
function recomputeGuests(evId) {
  const m = loadModel(eventById(evId));
  const guests = db.prepare('SELECT id, name, total, paid_at FROM guests WHERE event_id = ?').all(evId);
  const sel = db.prepare('SELECT item_id, qty FROM guest_items WHERE guest_id = ?');
  const upd = db.prepare(
    'UPDATE guests SET subtotal=?, tip_share=?, honoree_share=?, total=?, calc_exact=?, rounding_diff=? WHERE id=?'
  );
  let changed = 0;
  for (const g of guests) {
    const b = computeQuote(m, new Map(sel.all(g.id).map((r) => [r.item_id, r.qty])));
    if (b.total !== g.total) {
      if (g.paid_at) {
        throw new HttpError(409, `El cambio modificaría la cuota de ${g.name}, que ya está marcada como pagada. Desmarca el pago primero.`);
      }
      changed++;
    }
    upd.run(b.subtotal, b.tipShare, b.kind === 'v2' ? b.othersShare : b.honoreeShare, b.total, b.exact, b.roundingDiff, g.id);
  }
  return changed;
}

/** Guarda cambios. En setup reemplaza todo; después fusiona ítems por id y recalcula las cuotas. */
function saveEvent(id, data) {
  return tx(() => {
    const ev = eventById(id);
    if (ev.status === 'closed') throw new HttpError(409, 'La cuenta está cerrada; no se puede editar.');
    if (ev.rules_version !== 2) {
      throw new HttpError(409, 'Las cuentas históricas (propina porcentual) no se pueden editar.');
    }
    if (ev.status !== 'setup') {
      const registered = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE event_id = ?').get(id).n;
      if (data.payersCount < registered) {
        throw new HttpError(409, `Ya hay ${registered} participante(s) registrados; el número de pagadores no puede ser menor.`);
      }
    }
    const existing = db.prepare('SELECT id, name FROM items WHERE event_id = ?').all(id);
    const keep = new Set();
    const insItem = db.prepare('INSERT INTO items (event_id, name, unit_price, qty, is_tip, position) VALUES (?,?,?,?,?,?)');
    const updItem = db.prepare('UPDATE items SET name=?, unit_price=?, qty=?, is_tip=?, position=? WHERE id=? AND event_id=?');
    data.items.forEach((it, idx) => {
      if (it.id == null) return insItem.run(id, it.name, it.price, it.qty, it.isTip ? 1 : 0, idx);
      if (!existing.some((e) => e.id === it.id)) throw new HttpError(400, `"${it.name}": ítem desconocido.`);
      keep.add(it.id);
      const n = claimedUnits(it.id);
      if (it.qty < n) throw new HttpError(409, `"${it.name}": ya hay ${n} unidad(es) tomada(s); la cantidad no puede ser menor.`);
      if (it.isTip && n > 0) throw new HttpError(409, `"${it.name}" ya tiene consumos registrados y no puede marcarse como propina.`);
      updItem.run(it.name, it.price, it.qty, it.isTip ? 1 : 0, idx, it.id, id);
    });
    for (const ex of existing) {
      if (keep.has(ex.id)) continue;
      if (claimedUnits(ex.id) > 0) throw new HttpError(409, `No puedes quitar "${ex.name}" porque ya tiene consumos registrados.`);
      db.prepare('DELETE FROM items WHERE id = ?').run(ex.id);
    }
    db.prepare('UPDATE events SET name = ?, payers_count = ? WHERE id = ?').run(data.name, data.payersCount, id);
    let changed = 0;
    if (ev.status === 'setup') {
      db.prepare('DELETE FROM people WHERE event_id = ?').run(id);
      insertPeople(id, data.people);
    } else if (ev.status === 'open') {
      changed = recomputeGuests(id);
    }
    return { changed };
  });
}

/* --------------------------------------------------------------- Admin */

function adminState(ev) {
  if (ev.kind === 'cross') return crossAdminState(ev);
  const m = loadModel(ev);
  const gi = db
    .prepare(
      `SELECT gi.guest_id AS gid, gi.qty, i.name FROM guest_items gi
         JOIN items i ON i.id = gi.item_id JOIN guests g ON g.id = gi.guest_id WHERE g.event_id = ? ORDER BY i.position, i.id`
    )
    .all(ev.id);
  const guests = db
    .prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY id')
    .all(ev.id)
    .map((g) => ({
      id: g.id, name: g.name, subtotal: g.subtotal, tipShare: g.tip_share, othersShare: g.honoree_share,
      total: g.total, calcExact: g.calc_exact, roundingDiff: g.rounding_diff, paidAt: g.paid_at, createdAt: g.created_at,
      items: gi.filter((x) => x.gid === g.id).map((x) => ({ name: x.name, qty: x.qty })),
    }));
  const collected = guests.reduce((a, g) => a + g.total, 0);
  const paid = guests.filter((g) => g.paidAt).reduce((a, g) => a + g.total, 0);
  const unclaimed = m.items.filter((i) => !i.isTip);
  return {
    event: {
      id: ev.id, name: ev.name, kind: 'bill', status: ev.status, rulesVersion: ev.rules_version, payersCount: ev.payers_count,
      tipPercent: ev.rules_version === 1 ? ev.tip_percent : null, createdAt: ev.created_at,
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

function exportCsv(ev) {
  if (ev.kind === 'cross') return exportCrossCsv(ev);
  const s = adminState(ev);
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

/* ---------------------------------------------------- Cuentas cruzadas */

function validateCrossPayload(body) {
  const b = body || {};
  const name = cleanName(b.name) || 'Cuenta cruzada';
  if (name.length > 80) throw new HttpError(400, 'El nombre es demasiado largo (máx. 80).');
  const payersCount = Number(b.payersCount);
  if (!Number.isInteger(payersCount) || payersCount < 2 || payersCount > 500) {
    throw new HttpError(400, 'El número de participantes debe ser un entero entre 2 y 500.');
  }
  return { name, payersCount };
}

function validateExpenses(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 50) throw new HttpError(400, 'Lista de gastos inválida (máx. 50).');
  return raw.map((r, i) => {
    const description = cleanName(r && r.description);
    const amount = Number(r && r.amount);
    if (!description || description.length > 80) throw new HttpError(400, `Gasto ${i + 1}: escribe una descripción (máx. 80).`);
    if (!Number.isInteger(amount) || amount < 1 || amount > 1e9) {
      throw new HttpError(400, `"${description}": el importe debe ser un entero mayor que 0.`);
    }
    return { description, amount };
  });
}

function createCross(data) {
  return tx(() => {
    const r = db
      .prepare(
        `INSERT INTO events (name, tip_percent, rules_version, payers_count, company_token, honoree_token, kind)
         VALUES (?, 0, 2, ?, ?, ?, 'cross')`
      )
      .run(data.name, data.payersCount, newToken(), newToken());
    return Number(r.lastInsertRowid);
  });
}

function saveCross(id, data) {
  tx(() => {
    const ev = eventById(id);
    if (ev.kind !== 'cross') throw new HttpError(409, 'Esta cuenta no es de tipo cruzada.');
    if (ev.status === 'closed') throw new HttpError(409, 'La cuenta está cerrada; no se puede editar.');
    const n = db.prepare('SELECT COUNT(*) AS n FROM cross_members WHERE event_id = ?').get(id).n;
    if (data.payersCount < n) throw new HttpError(409, `Ya hay ${n} participante(s) registrados; el número no puede ser menor.`);
    db.prepare('UPDATE events SET name = ?, payers_count = ? WHERE id = ?').run(data.name, data.payersCount, id);
  });
}

/** Agrega un miembro con sus gastos (dentro de una transacción). Respeta el número de participantes. */
function addMember(ev, rawName, rawExpenses) {
  const name = cleanName(rawName);
  if (!name) throw new HttpError(400, 'Escribe tu nombre.');
  if (name.length > 60) throw new HttpError(400, 'El nombre es demasiado largo (máx. 60).');
  const expenses = validateExpenses(rawExpenses);
  const n = db.prepare('SELECT COUNT(*) AS n FROM cross_members WHERE event_id = ?').get(ev.id).n;
  if (n >= ev.payers_count) throw new HttpError(409, 'Ya se registraron todos los participantes.');
  if (db.prepare('SELECT 1 AS x FROM cross_members WHERE event_id = ? AND lower(name) = lower(?)').get(ev.id, name)) {
    throw new HttpError(409, 'Ya hay un participante con ese nombre. Agrega tu apellido o una inicial.');
  }
  const id = Number(db.prepare('INSERT INTO cross_members (event_id, name) VALUES (?, ?)').run(ev.id, name).lastInsertRowid);
  const ins = db.prepare('INSERT INTO cross_expenses (member_id, description, amount) VALUES (?, ?, ?)');
  for (const x of expenses) ins.run(id, x.description, x.amount);
  return id;
}

/** Resultado de una cuenta cruzada: lo pagado por cada uno, su cuota, su saldo y quién le paga a quién. */
function crossResult(ev) {
  const members = db.prepare('SELECT id, name FROM cross_members WHERE event_id = ? ORDER BY id').all(ev.id);
  const exp = db
    .prepare(
      `SELECT x.id, x.member_id AS memberId, x.description, x.amount
         FROM cross_expenses x JOIN cross_members m ON m.id = x.member_id WHERE m.event_id = ? ORDER BY x.id`
    )
    .all(ev.id);
  const withExp = members.map((m) => ({ ...m, expenses: exp.filter((x) => x.memberId === m.id) }));
  const r = repartir(
    withExp.map((m) => ({ id: m.id, name: m.name, pagado: m.expenses.reduce((a, x) => a + x.amount, 0) })),
    ev.payers_count
  );
  return {
    participants: r.participantes,
    registered: r.registrados,
    pending: r.sinRegistrar,
    total: r.total,
    sharePerPerson: r.cuotaExacta,
    complete: r.completo,
    members: r.miembros.map((d, i) => ({
      id: d.id, name: d.name, paid: d.pagado, share: d.cuota, balance: d.saldo,
      expenses: withExp[i].expenses.map((x) => ({ id: x.id, description: x.description, amount: x.amount })),
    })),
    transfers: r.transferencias,
  };
}

function crossAdminState(ev) {
  return {
    event: {
      id: ev.id, name: ev.name, kind: 'cross', status: ev.status, rulesVersion: ev.rules_version,
      payersCount: ev.payers_count, createdAt: ev.created_at, links: { company: `/company?t=${ev.company_token}` },
    },
    cross: crossResult(ev),
  };
}

function crossPublicState(ev) {
  if (ev.status === 'setup') return { status: 'setup', kind: 'cross', eventName: ev.name };
  return { status: ev.status, kind: 'cross', eventName: ev.name, ...crossResult(ev) };
}

function exportCrossCsv(ev) {
  const { cross: c } = crossAdminState(ev);
  const rows = [['Nombre', 'Gastos', 'Pagó', 'Cuota', 'Saldo (positivo: le deben · negativo: debe)']];
  for (const m of c.members) rows.push([m.name, m.expenses.map((x) => `${x.description}: ${x.amount}`).join(' | '), m.paid, m.share, m.balance]);
  rows.push([], ['Total gastado', '', c.total], ['Participantes', '', c.participants], ['Registrados', '', c.registered]);
  rows.push([], c.complete ? ['Quién paga a quién', 'De', 'A', 'Monto'] : ['Quién paga a quién: faltan participantes por registrar']);
  for (const t of c.transfers) rows.push(['', t.from.name, t.to.name, t.amount]);
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* -------------------------------------------------------------- Rutas */

const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });
const evFrom = (ctx) => eventById(Number(ctx.params[0]));

route('GET', '/api/config', () => ({ currency: CURRENCY, locale: LOCALE }));

/* ---- Sesión de administrador ---- */
route('GET', '/api/admin/session', ({ req }) => ({ required: auth.enabled, authenticated: auth.isAuthed(req) }));

route('POST', '/api/admin/login', ({ req, res, body, ip }) => {
  const key = `login:${ip}`;
  const blocked = limiter.blocked(key, 8, 600_000);
  if (!blocked.ok) throw Object.assign(new HttpError(429, 'Demasiados intentos. Espera unos minutos.'), { retry: blocked.retry });
  if (!auth.enabled) return { ok: true };
  if (!auth.checkPassword((body && body.password) || '')) {
    limiter.fail(key, 600_000);
    throw new HttpError(401, 'Contraseña incorrecta.');
  }
  limiter.reset(key);
  auth.setCookie(res);
  return { ok: true };
});

route('POST', '/api/admin/logout', ({ res }) => {
  auth.clearCookie(res);
  return { ok: true };
});

/* ---- Cuentas ---- */
route('GET', '/api/admin/events', () => ({
  events: db
    .prepare(
      `SELECT e.id, e.name, e.kind, e.status, e.rules_version AS rulesVersion, e.created_at AS createdAt,
              (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) AS guests
         FROM events e ORDER BY e.id DESC LIMIT 200`
    )
    .all(),
}), { admin: true });

route('POST', '/api/admin/events', ({ body }) => {
  if (body && body.kind === 'cross') return adminState(eventById(createCross(validateCrossPayload(body))));
  const id = createEvent(validateEventPayload(body));
  return adminState(eventById(id));
}, { admin: true });

route('GET', '/api/admin/events/(\\d+)', (ctx) => adminState(evFrom(ctx)), { admin: true });

route('PUT', '/api/admin/events/(\\d+)', (ctx) => {
  const ev = evFrom(ctx);
  if (ev.kind === 'cross') {
    saveCross(ev.id, validateCrossPayload(ctx.body));
    return adminState(eventById(ev.id));
  }
  const { changed } = saveEvent(ev.id, validateEventPayload(ctx.body));
  return { ...adminState(eventById(ev.id)), recalculated: changed };
}, { admin: true });

route('POST', '/api/admin/events/(\\d+)/publish', (ctx) => {
  tx(() => {
    const ev = evFrom(ctx);
    if (ev.status !== 'setup') throw new HttpError(409, 'La cuenta ya fue habilitada.');
    if (ev.kind === 'cross') {
      if (ev.payers_count < 2) throw new HttpError(400, 'Indica cuántos participantes hay (al menos 2).');
      db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(ev.id);
      return;
    }
    const m = loadModel(ev);
    if (!m.items.some((i) => !i.isTip)) throw new HttpError(400, 'Agrega al menos un ítem de consumo.');
    if (ev.rules_version === 2 && ev.payers_count < 1) {
      throw new HttpError(400, 'Indica cuántos participantes pagan (al menos 1).');
    }
    const next = m.people.length ? 'honoree' : 'open';
    db.prepare('UPDATE events SET status = ? WHERE id = ?').run(next, ev.id);
  });
  return adminState(evFrom(ctx));
}, { admin: true });

route('POST', '/api/admin/events/(\\d+)/unpublish', (ctx) => {
  tx(() => {
    const ev = evFrom(ctx);
    if (ev.kind === 'cross') {
      const n = db.prepare('SELECT COUNT(*) AS n FROM cross_members WHERE event_id = ?').get(ev.id).n;
      if (ev.status !== 'open' || n > 0) throw new HttpError(409, 'Solo se puede volver a borrador antes de que alguien se registre.');
      db.prepare("UPDATE events SET status = 'setup' WHERE id = ?").run(ev.id);
      return;
    }
    const reg = db.prepare('SELECT COUNT(*) AS n FROM people WHERE event_id = ? AND registered_at IS NOT NULL').get(ev.id).n;
    if (ev.status !== 'honoree' || reg > 0) {
      throw new HttpError(409, 'Solo se puede volver a editar antes de que alguien registre su consumo.');
    }
    db.prepare("UPDATE events SET status = 'setup' WHERE id = ?").run(ev.id);
  });
  return adminState(evFrom(ctx));
}, { admin: true });

route('POST', '/api/admin/events/(\\d+)/close', (ctx) => {
  tx(() => {
    const ev = evFrom(ctx);
    if (ev.status !== 'honoree' && ev.status !== 'open') throw new HttpError(409, 'No hay un cobro activo para cerrar.');
    if (ev.kind === 'cross') {
      const k = db.prepare('SELECT COUNT(*) AS n FROM cross_members WHERE event_id = ?').get(ev.id).n;
      if (k !== ev.payers_count && k !== 0) {
        throw new HttpError(409, `No se puede cerrar: hay ${k} de ${ev.payers_count} participantes registrados. Ajusta el número de participantes o espera a los faltantes.`);
      }
      db.prepare("UPDATE events SET status = 'closed' WHERE id = ?").run(ev.id);
      return;
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE event_id = ?').get(ev.id).n;
    if (ev.rules_version === 2 && n !== ev.payers_count && n !== 0) {
      throw new HttpError(409, `No se puede cerrar: hay ${n} de ${ev.payers_count} participantes registrados (cuotas pendientes de cálculo).`);
    }
    db.prepare("UPDATE events SET status = 'closed' WHERE id = ?").run(ev.id);
  });
  return adminState(evFrom(ctx));
}, { admin: true });

route('POST', '/api/admin/events/(\\d+)/tokens/rotate', (ctx) => {
  const ev = evFrom(ctx);
  if (ev.status === 'closed') throw new HttpError(409, 'La cuenta está cerrada.');
  db.prepare('UPDATE events SET company_token = ?, honoree_token = ? WHERE id = ?').run(newToken(), newToken(), ev.id);
  return adminState(eventById(ev.id));
}, { admin: true });

route('DELETE', '/api/admin/events/(\\d+)/guests/(\\d+)', (ctx) => {
  tx(() => {
    const ev = evFrom(ctx);
    if (ev.status === 'closed') throw new HttpError(409, 'El cobro está cerrado.');
    const g = db.prepare('SELECT paid_at FROM guests WHERE id = ? AND event_id = ?').get(Number(ctx.params[1]), ev.id);
    if (!g) throw new HttpError(404, 'Registro no encontrado.');
    if (g.paid_at) throw new HttpError(409, 'Ese registro está marcado como pagado; desmarca el pago primero.');
    db.prepare('DELETE FROM guests WHERE id = ?').run(Number(ctx.params[1]));
  });
  return adminState(evFrom(ctx));
}, { admin: true });

route('POST', '/api/admin/events/(\\d+)/guests/(\\d+)/paid', (ctx) => {
  const ev = evFrom(ctx);
  if (ev.status !== 'open' && ev.status !== 'closed') throw new HttpError(409, 'Aún no hay cobro activo.');
  const paid = ctx.body && ctx.body.paid === true;
  const r = db
    .prepare('UPDATE guests SET paid_at = ? WHERE id = ? AND event_id = ?')
    .run(paid ? new Date().toISOString() : null, Number(ctx.params[1]), ev.id);
  if (r.changes === 0) throw new HttpError(404, 'Registro no encontrado.');
  return adminState(ev);
}, { admin: true });

route('GET', '/api/admin/events/(\\d+)/export.csv', (ctx) => {
  const ev = evFrom(ctx);
  const slug = ev.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cuenta';
  return {
    raw: true, status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug}-${ev.id}.csv"` },
    body: exportCsv(ev),
  };
}, { admin: true });

route('GET', '/api/admin/backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  try {
    const file = backup.snapshot(db, dir, 1);
    return {
      raw: true, status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="cuenta-${new Date().toISOString().slice(0, 10)}.db"` },
      body: fs.readFileSync(file),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, { admin: true });

/* ---- Cuentas cruzadas (admin) ---- */

const crossEv = (ctx) => {
  const ev = evFrom(ctx);
  if (ev.kind !== 'cross') throw new HttpError(409, 'Esta cuenta no es de tipo cruzada.');
  if (ev.status === 'closed') throw new HttpError(409, 'La cuenta está cerrada.');
  return ev;
};

route('POST', '/api/admin/events/(\\d+)/members', (ctx) => {
  tx(() => addMember(crossEv(ctx), ctx.body && ctx.body.name, ctx.body && ctx.body.expenses));
  return adminState(evFrom(ctx));
}, { admin: true });

route('DELETE', '/api/admin/events/(\\d+)/members/(\\d+)', (ctx) => {
  tx(() => {
    const ev = crossEv(ctx);
    const r = db.prepare('DELETE FROM cross_members WHERE id = ? AND event_id = ?').run(Number(ctx.params[1]), ev.id);
    if (r.changes === 0) throw new HttpError(404, 'Participante no encontrado.');
  });
  return adminState(evFrom(ctx));
}, { admin: true });

route('POST', '/api/admin/events/(\\d+)/members/(\\d+)/expenses', (ctx) => {
  tx(() => {
    const ev = crossEv(ctx);
    const mid = Number(ctx.params[1]);
    if (!db.prepare('SELECT 1 AS x FROM cross_members WHERE id = ? AND event_id = ?').get(mid, ev.id)) {
      throw new HttpError(404, 'Participante no encontrado.');
    }
    const list = validateExpenses([ctx.body]);
    const count = db.prepare('SELECT COUNT(*) AS n FROM cross_expenses WHERE member_id = ?').get(mid).n;
    if (count + list.length > 50) throw new HttpError(400, 'Máximo 50 gastos por participante.');
    db.prepare('INSERT INTO cross_expenses (member_id, description, amount) VALUES (?, ?, ?)').run(mid, list[0].description, list[0].amount);
  });
  return adminState(evFrom(ctx));
}, { admin: true });

route('DELETE', '/api/admin/events/(\\d+)/expenses/(\\d+)', (ctx) => {
  tx(() => {
    const ev = crossEv(ctx);
    const r = db
      .prepare('DELETE FROM cross_expenses WHERE id = ? AND member_id IN (SELECT id FROM cross_members WHERE event_id = ?)')
      .run(Number(ctx.params[1]), ev.id);
    if (r.changes === 0) throw new HttpError(404, 'Gasto no encontrado.');
  });
  return adminState(evFrom(ctx));
}, { admin: true });

/* ---- Cumplimentado (exentos e invitados): nunca expone precios ni propina ---- */

route('GET', '/api/honoree', ({ query }) => {
  const ev = eventByToken('honoree', query);
  if (!ev || ev.kind === 'cross') return { status: 'invalid' };
  if (ev.status === 'setup') return { status: 'setup', eventName: ev.name };
  const m = loadModel(ev);
  return {
    status: ev.status,
    eventName: ev.name,
    people: m.people.map((p) => ({ id: p.id, name: p.name, kind: p.kind, registered: !!p.registeredAt })),
    items: m.items.filter((i) => !i.isTip).map((i) => ({ id: i.id, name: i.name, qty: i.qty, remaining: i.qty - i.peopleQty })),
  };
});

route('POST', '/api/honoree', ({ query, body }) => {
  return tx(() => {
    const found = eventByToken('honoree', query);
    if (!found || found.kind === 'cross') throw new HttpError(404, 'Enlace inválido.');
    const ev = eventById(found.id);
    if (ev.status !== 'honoree') throw new HttpError(409, 'Esta cuenta no está esperando consumos de exentos o invitados.');
    const m = loadModel(ev);
    const pending = m.people.filter((p) => !p.registeredAt);
    let person;
    if (body && body.personId != null) person = m.people.find((p) => p.id === Number(body.personId));
    else if (pending.length === 1) person = pending[0];
    if (!person) throw new HttpError(400, 'Elige quién eres en la lista.');
    if (person.registeredAt) throw new HttpError(409, `${person.name} ya registró su consumo.`);
    const sel = normalizeSelection(body && body.selection, m.items, (it) => it.qty - it.peopleQty);
    const ins = db.prepare('INSERT INTO person_items (person_id, item_id, qty) VALUES (?, ?, ?)');
    for (const [itemId, qty] of sel) ins.run(person.id, itemId, qty);
    db.prepare("UPDATE people SET registered_at = datetime('now') WHERE id = ?").run(person.id);
    const left = pending.length - 1;
    if (left === 0) db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(ev.id);
    return { status: left === 0 ? 'open' : 'honoree', pending: left };
  });
});

/* ---- Participantes que pagan ---- */

route('GET', '/api/company', ({ query }) => {
  const ev = eventByToken('company', query);
  if (!ev) return { status: 'invalid' };
  if (ev.kind === 'cross') return crossPublicState(ev);
  if (ev.status !== 'open') return { status: ev.status, eventName: ev.name };
  const m = loadModel(ev);
  const registered = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE event_id = ?').get(ev.id).n;
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

function openEventFor(query) {
  const found = eventByToken('company', query);
  if (!found) throw new HttpError(404, 'Enlace inválido.');
  if (found.kind === 'cross') throw new HttpError(409, 'Esta cuenta es de tipo cruzada.');
  const ev = eventById(found.id);
  if (ev.status !== 'open') throw new HttpError(409, 'El cobro todavía no está habilitado o ya fue cerrado.');
  return ev;
}

/* ---- Cuentas cruzadas (participantes) ---- */

route('POST', '/api/company/members', ({ query, body }) => {
  return tx(() => {
    const found = eventByToken('company', query);
    if (!found) throw new HttpError(404, 'Enlace inválido.');
    const ev = eventById(found.id);
    if (ev.kind !== 'cross') throw new HttpError(409, 'Esta cuenta no es de tipo cruzada.');
    if (ev.status !== 'open') throw new HttpError(409, 'La cuenta todavía no está habilitada o ya fue cerrada.');
    const id = addMember(ev, body && body.name, body && body.expenses);
    return { member: { id }, ...crossPublicState(ev) };
  });
});

function checkSlots(ev) {
  if (ev.rules_version !== 2) return;
  const n = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE event_id = ?').get(ev.id).n;
  if (n >= ev.payers_count) throw new HttpError(409, 'Ya se registraron todos los participantes que pagan.');
}

const requireNonEmpty = (sel) => {
  if (sel.size === 0) throw new HttpError(400, 'Selecciona al menos un ítem.');
};

route('POST', '/api/company/quote', ({ query, body }) => {
  const ev = openEventFor(query);
  checkSlots(ev);
  const m = loadModel(ev);
  const sel = normalizeSelection(body && body.selection, m.items, (it) => it.available);
  requireNonEmpty(sel);
  return { breakdown: computeQuote(m, sel) };
});

route('POST', '/api/company/guests', ({ query, body }) => {
  const name = cleanName(body && body.name);
  if (!name) throw new HttpError(400, 'Escribe tu nombre.');
  if (name.length > 60) throw new HttpError(400, 'El nombre es demasiado largo (máx. 60).');
  return tx(() => {
    const ev = openEventFor(query);
    checkSlots(ev);
    const m = loadModel(ev);
    const sel = normalizeSelection(body && body.selection, m.items, (it) => it.available);
    requireNonEmpty(sel);
    const dup = db.prepare('SELECT 1 AS x FROM guests WHERE event_id = ? AND lower(name) = lower(?)').get(ev.id, name);
    if (dup) throw new HttpError(409, 'Ya hay un registro con ese nombre. Agrega tu apellido o una inicial.');
    const b = computeQuote(m, sel);
    const r = db
      .prepare(
        `INSERT INTO guests (event_id, name, subtotal, tip_share, honoree_share, total, calc_exact, rounding_diff)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(ev.id, name, b.subtotal, b.tipShare, b.kind === 'v2' ? b.othersShare : b.honoreeShare, b.total, b.exact, b.roundingDiff);
    const gid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO guest_items (guest_id, item_id, qty) VALUES (?,?,?)');
    for (const [itemId, qty] of sel) ins.run(gid, itemId, qty);
    return { guest: { id: gid, name }, breakdown: b };
  });
});

/* ------------------------------------------------------------- HTTP */

const PAGES = {
  '/admin': 'admin.html',
  '/admin/login': 'login.html',
  '/cumplimentado': 'cumplimentado.html',
  '/company': 'company.html',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
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
    if (r.admin) {
      if (!auth.isAuthed(req)) throw new HttpError(401, 'Inicia sesión como administrador.');
      const site = req.headers['sec-fetch-site'];
      if (req.method !== 'GET' && site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Origen no permitido.');
    }
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
    if (pathname === '/admin' && !auth.isAuthed(req)) {
      res.writeHead(302, { Location: '/admin/login' });
      return res.end();
    }
    return serveFile(res, path.join(PUBLIC_DIR, PAGES[pathname]), 'no-cache');
  }
  if (pathname.startsWith('/assets/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(path.join(PUBLIC_DIR, 'assets') + path.sep)) return sendJson(res, 404, { error: 'No encontrado.' });
    return serveFile(res, file, file.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache');
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
      db.prepare('SELECT 1').get();
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

const backups = backup.schedule(db, { dir: BACKUP_DIR, hours: BACKUP_HOURS, keep: BACKUP_KEEP });

server.listen(PORT, HOST, () => {
  console.log(`Come Along escuchando en http://localhost:${PORT} (${NODE_ENV})`);
  console.log(`  Admin: /admin ${auth.enabled ? '(con contraseña)' : '(SIN contraseña: define ADMIN_PASSWORD)'}`);
  console.log(`  Respaldos: ${BACKUP_HOURS > 0 ? `cada ${BACKUP_HOURS} h en ${BACKUP_DIR} (conserva ${BACKUP_KEEP})` : 'desactivados'}`);
});

function shutdown() {
  if (backups) backups.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
