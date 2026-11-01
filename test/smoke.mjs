// Pruebas de API contra servidores reales con BD temporal.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'cuenta-'));
const PASS = 'clave-de-prueba-123';
const servers = [];

async function start(name, extraEnv = {}) {
  const port = 3100 + Math.floor(Math.random() * 800);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: join(tmp, `${name}.db`), ADMIN_PASSWORD: PASS, BACKUP_INTERVAL_HOURS: '0', ...extraEnv },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const c = { base, cookie: '' };
  c.call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  c.login = async (pass = PASS) => {
    const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass }) });
    const sc = res.headers.get('set-cookie');
    if (res.status === 200 && sc) c.cookie = sc.split(';')[0];
    return res.status;
  };
  c.adm = (m, p, b) => c.call(m, `/api/admin${p}`, b);
  return c;
}

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const tokenOf = (link) => new URL(link, 'http://x').searchParams.get('t');

try {
  const s = await start('main');
  console.log('API · reglas v2');

  await ok('/health responde y /admin redirige al login sin sesión', async () => {
    assert.equal((await s.call('GET', '/health')).data.status, 'ok');
    const r = await fetch(s.base + '/admin', { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/admin/login');
  });

  await ok('API de admin exige sesión; contraseña incorrecta se rechaza; la correcta entrega cookie HttpOnly', async () => {
    assert.equal((await s.adm('GET', '/events')).status, 401);
    assert.equal(await s.login('mala'), 401);
    const res = await fetch(s.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
    const sc = res.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    assert.equal(await s.login(), 200);
    assert.equal((await s.adm('GET', '/events')).status, 200);
    const forged = await s.call('GET', '/api/admin/events', null, { Cookie: 'ca_admin=9999999999999.firma' });
    assert.equal(forged.status, 401);
  });

  await ok('sin token o con token inválido no se ve nada', async () => {
    assert.equal((await s.call('GET', '/api/company')).data.status, 'invalid');
    assert.equal((await s.call('GET', '/api/honoree?t=aaaaaaaaaaaaaaaaaaaaaaaa')).data.status, 'invalid');
    assert.equal((await s.call('POST', '/api/company/guests?t=zzzzzzzzzzzzzzzzzzzzzz', { name: 'x', selection: [] })).status, 404);
  });

  let ev, items, T, H;
  await ok('crear cuenta: sin porcentaje, propina como ítem manual, 3 pagadores, 1 exento y 1 invitado', async () => {
    const r = await s.adm('POST', '/events', {
      name: 'Cena RN-04', payersCount: 3, exempt: ['Laura'], guests: ['Pedro invitado'], tipPercent: 50,
      items: [{ name: 'Menú', price: 5000, qty: 20 }, { name: 'Propina', price: 12000, qty: 1, isTip: true }],
    });
    assert.equal(r.status, 200);
    ev = r.data;
    assert.equal(ev.event.rulesVersion, 2);
    assert.equal(ev.event.tipPercent, null, 'sin porcentaje en cuentas nuevas');
    assert.equal(ev.summary.invoiceTotal, 112000);
    assert.equal(ev.summary.tipTotal, 12000);
    assert.equal(ev.event.payersCount, 3);
    items = Object.fromEntries(ev.items.map((i) => [i.name, i.id]));
    T = { honoree: tokenOf(ev.event.links.honoree), company: tokenOf(ev.event.links.company) };
    assert.notEqual(T.honoree, T.company);
  });

  await ok('validaciones: pagadores obligatorios para habilitar, nombres repetidos, solo propina', async () => {
    const bad = await s.adm('POST', '/events', { name: 'x', payersCount: 0, items: [{ name: 'A', price: 1, qty: 1 }] });
    const id = bad.data.event.id;
    assert.equal((await s.adm('POST', `/events/${id}/publish`, {})).status, 400);
    assert.equal((await s.adm('POST', '/events', { name: 'x', payersCount: 1, exempt: ['Ana'], guests: ['ana'], items: [{ name: 'A', price: 1, qty: 1 }] })).status, 400);
    assert.equal((await s.adm('POST', '/events', { name: 'x', payersCount: 1, items: [{ name: 'Propina', price: 1, qty: 1, isTip: true }] })).status, 400);
    assert.equal((await s.adm('POST', '/events', { name: 'x', payersCount: 1.5, items: [{ name: 'A', price: 1, qty: 1 }] })).status, 400);
    assert.equal((await s.adm('POST', '/events', { name: 'x', payersCount: 1, items: [{ name: 'A', price: 10.5, qty: 1 }] })).status, 400);
  });

  await ok('bloqueos por estado: borrador -> nada disponible', async () => {
    assert.equal((await s.call('GET', `/api/honoree?t=${T.honoree}`)).data.status, 'setup');
    assert.equal((await s.call('GET', `/api/company?t=${T.company}`)).data.status, 'setup');
    assert.equal((await s.call('POST', `/api/company/quote?t=${T.company}`, { selection: [{ itemId: items['Menú'], qty: 1 }] })).status, 409);
  });

  await ok('habilitar: pasa a "honoree" (hay exentos e invitados)', async () => {
    assert.equal((await s.adm('POST', `/events/${ev.event.id}/publish`, {})).data.event.status, 'honoree');
    assert.equal((await s.call('GET', `/api/company?t=${T.company}`)).data.status, 'honoree');
  });

  await ok('exentos/invitados NO reciben precios ni propina', async () => {
    const r = await s.call('GET', `/api/honoree?t=${T.honoree}`);
    const raw = JSON.stringify(r.data).toLowerCase();
    assert.ok(!/price|precio|tip|propina|unit|12000|5000/.test(raw), raw);
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.people.length, 2);
  });

  const persons = {};
  await ok('registro de exentos e invitados (validaciones y apertura automática)', async () => {
    const r = await s.call('GET', `/api/honoree?t=${T.honoree}`);
    for (const p of r.data.people) persons[p.name] = p.id;
    const post = (personId, qty, itemId = items['Menú']) => s.call('POST', `/api/honoree?t=${T.honoree}`, { personId, selection: [{ itemId, qty }] });
    assert.equal((await post(persons.Laura, 99)).status, 409, 'más de lo que hay');
    assert.equal((await post(persons.Laura, 1, items['Propina'])).status, 400, 'la propina no se puede consumir');
    assert.equal((await s.call('POST', `/api/honoree?t=${T.honoree}`, { selection: [] })).status, 400, 'hay que elegir persona');
    assert.equal((await post(persons.Laura, 3)).data.status, 'honoree');
    assert.equal((await post(persons.Laura, 1)).status, 409, 'no se registra dos veces');
    assert.equal((await post(persons['Pedro invitado'], 2)).data.status, 'open');
    assert.equal((await s.call('GET', `/api/company?t=${T.company}`)).data.status, 'open');
  });

  await ok('participantes ven solo ítems de consumo con precio y disponibilidad (20-3-2 = 15)', async () => {
    const r = (await s.call('GET', `/api/company?t=${T.company}`)).data;
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].available, 15);
    assert.equal(r.items[0].price, 5000);
    assert.equal(r.tipPercent, null);
    assert.equal(r.payersCount, 3);
  });

  const q = (qty) => s.call('POST', `/api/company/quote?t=${T.company}`, { selection: [{ itemId: items['Menú'], qty }] });
  const save = (name, qty) => s.call('POST', `/api/company/guests?t=${T.company}`, { name, selection: [{ itemId: items['Menú'], qty }] });

  await ok('ejemplo de aceptación RN-04: 37.400 / 42.400 / 32.400', async () => {
    const a = (await q(5)).data.breakdown;
    assert.equal(a.kind, 'v2');
    assert.deepEqual([a.subtotal, a.tipShare, a.othersShare, a.adjustment, a.total], [25000, 4000, 8333, 67, 37400]);
    assert.equal(a.subtotal + a.tipShare + a.othersShare + a.adjustment, a.total);
    assert.equal((await q(6)).data.breakdown.total, 42400);
    assert.equal((await q(4)).data.breakdown.total, 32400);
    for (const n of [1, 2, 3, 7]) assert.equal((await q(n)).data.breakdown.total % 100, 0);
  });

  await ok('no se puede cerrar con cuotas pendientes (2 de 3) ni asignar a quien no existe', async () => {
    assert.equal((await save('Ana', 5)).data.breakdown.total, 37400);
    assert.equal((await save('Beto', 6)).data.breakdown.total, 42400);
    assert.equal((await s.adm('POST', `/events/${ev.event.id}/close`, {})).status, 409);
    assert.equal((await save('ana', 1)).status, 409, 'nombre duplicado');
    assert.equal((await save('  ', 1)).status, 400);
  });

  await ok('tercer pagador completa; un cuarto es rechazado; totales y diferencia por redondeo', async () => {
    assert.equal((await save('Caro', 4)).data.breakdown.total, 32400);
    assert.equal((await save('Dani', 1)).status, 409);
    assert.equal((await q(1)).status, 409, 'ya no hay cupos');
    const st = (await s.adm('GET', `/events/${ev.event.id}`)).data;
    assert.equal(st.summary.collected, 112200);
    assert.equal(st.summary.difference, 200);
    assert.equal(st.summary.roundingDiff, 200);
    assert.equal(st.summary.payersRegistered, 3);
    assert.equal(st.summary.unclaimedUnits, 0);
    assert.ok(st.guests.every((g) => g.total % 100 === 0));
    assert.deepEqual(st.guests.map((g) => g.calcExact), [37333.3333, 42333.3333, 32333.3333]);
  });

  await ok('marcar pagos y conciliar; no se elimina un registro pagado', async () => {
    let st = (await s.adm('GET', `/events/${ev.event.id}`)).data;
    const [ana, beto] = st.guests;
    st = (await s.adm('POST', `/events/${ev.event.id}/guests/${ana.id}/paid`, { paid: true })).data;
    assert.equal(st.summary.paid, 37400);
    assert.equal(st.summary.awaitingPayment, 112200 - 37400);
    assert.equal((await s.adm('DELETE', `/events/${ev.event.id}/guests/${ana.id}`)).status, 409);
    await s.adm('POST', `/events/${ev.event.id}/guests/${ana.id}/paid`, { paid: false });
    assert.equal((await s.adm('POST', `/events/${ev.event.id}/guests/${beto.id}/paid`, { paid: true })).status, 200);
  });

  await ok('cerrar cobro: bloquea nuevos registros y edición', async () => {
    assert.equal((await s.adm('POST', `/events/${ev.event.id}/close`, {})).data.event.status, 'closed');
    assert.equal((await s.call('GET', `/api/company?t=${T.company}`)).data.status, 'closed');
    assert.equal((await save('Tarde', 1)).status, 409);
    const put = await s.adm('PUT', `/events/${ev.event.id}`, { name: 'x', payersCount: 3, items: [{ name: 'Menú', price: 1, qty: 20 }] });
    assert.equal(put.status, 409);
  });

  /* ---------- edición después de habilitar, recálculo y pagos ---------- */
  console.log('API · edición posterior, CSV y enlaces');
  let e2, T2, m2, t2;
  await ok('cuenta sin exentos/invitados abre directo; editar precio recalcula las cuotas', async () => {
    const r = await s.adm('POST', '/events', { name: 'Simple', payersCount: 2, items: [{ name: 'Menú', price: 5000, qty: 4 }, { name: 'Propina', price: 1000, qty: 1, isTip: true }] });
    e2 = r.data;
    T2 = tokenOf(e2.event.links.company);
    assert.equal((await s.adm('POST', `/events/${e2.event.id}/publish`, {})).data.event.status, 'open');
    m2 = e2.items.find((i) => i.name === 'Menú').id;
    t2 = e2.items.find((i) => i.name === 'Propina').id;
    const g = await s.call('POST', `/api/company/guests?t=${T2}`, { name: '=SUM(1+1)', selection: [{ itemId: m2, qty: 2 }] });
    assert.equal(g.data.breakdown.total, 10500); // 10000 + 1000/2 = 10500
    const put = await s.adm('PUT', `/events/${e2.event.id}`, {
      name: 'Simple', payersCount: 2,
      items: [{ id: m2, name: 'Menú', price: 6000, qty: 4 }, { id: t2, name: 'Propina', price: 1000, qty: 1, isTip: true }],
    });
    assert.equal(put.status, 200);
    assert.equal(put.data.recalculated, 1);
    assert.equal(put.data.guests[0].total, 12500);
  });

  await ok('edición: no bajar de lo tomado, no quitar ítems con consumos, no bajar pagadores, no tocar cuotas pagadas', async () => {
    const base = (items, payersCount = 2) => ({ name: 'Simple', payersCount, items });
    const menu = (o = {}) => ({ id: m2, name: 'Menú', price: 6000, qty: 4, ...o });
    assert.equal((await s.adm('PUT', `/events/${e2.event.id}`, base([menu({ qty: 1 })]))).status, 409);
    assert.equal((await s.adm('PUT', `/events/${e2.event.id}`, base([{ name: 'Otro', price: 1, qty: 1 }]))).status, 409, 'quitar Menú');
    assert.equal((await s.adm('PUT', `/events/${e2.event.id}`, base([menu({ isTip: true }), { name: 'Otro', price: 1, qty: 1 }]))).status, 409);
    assert.equal((await s.adm('PUT', `/events/${e2.event.id}`, base([menu()], 0))).status, 409);
    const gid = (await s.adm('GET', `/events/${e2.event.id}`)).data.guests[0].id;
    await s.adm('POST', `/events/${e2.event.id}/guests/${gid}/paid`, { paid: true });
    const r = await s.adm('PUT', `/events/${e2.event.id}`, base([menu({ price: 7000 }), { id: t2, name: 'Propina', price: 1000, qty: 1, isTip: true }]));
    assert.equal(r.status, 409);
    assert.match(r.data.error, /pagada/);
    const still = (await s.adm('GET', `/events/${e2.event.id}`)).data;
    assert.equal(still.guests[0].total, 12500, 'la transacción revirtió el cambio');
    assert.equal(still.items.find((i) => i.id === m2).price, 6000);
  });

  await ok('exportar CSV: BOM, cabecera, totales y protección contra inyección de fórmulas', async () => {
    const r = await s.call('GET', `/api/admin/events/${e2.event.id}/export.csv`);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const raw = Buffer.from(await (await fetch(s.base + `/api/admin/events/${e2.event.id}/export.csv`, { headers: { Cookie: s.cookie } })).arrayBuffer());
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 para Excel');
    assert.ok(r.data.startsWith('Nombre,'));
    assert.ok(r.data.includes("'=SUM(1+1)"), 'el nombre peligroso quedó neutralizado');
    assert.ok(!/^=SUM/m.test(r.data));
    assert.ok(r.data.includes('12500'));
  });

  await ok('regenerar enlaces invalida los anteriores; varias cuentas conviven', async () => {
    const before = tokenOf(e2.event.links.company);
    const after = (await s.adm('POST', `/events/${e2.event.id}/tokens/rotate`, {})).data;
    const newTok = tokenOf(after.event.links.company);
    assert.notEqual(before, newTok);
    assert.equal((await s.call('GET', `/api/company?t=${before}`)).data.status, 'invalid');
    assert.equal((await s.call('GET', `/api/company?t=${newTok}`)).data.status, 'open');
    assert.equal((await s.call('GET', `/api/company?t=${T.company}`)).data.status, 'closed', 'la otra cuenta no se mezcla');
    assert.ok((await s.adm('GET', '/events')).data.events.length >= 3);
  });

  await ok('volver a borrador solo antes de que alguien registre', async () => {
    const r = await s.adm('POST', '/events', { name: 'Borr', payersCount: 1, exempt: ['Z'], items: [{ name: 'A', price: 100, qty: 2 }] });
    const id = r.data.event.id;
    await s.adm('POST', `/events/${id}/publish`, {});
    assert.equal((await s.adm('POST', `/events/${id}/unpublish`, {})).data.event.status, 'setup');
    await s.adm('POST', `/events/${id}/publish`, {});
    const tok = tokenOf((await s.adm('GET', `/events/${id}`)).data.event.links.honoree);
    await s.call('POST', `/api/honoree?t=${tok}`, { selection: [{ itemId: r.data.items[0].id, qty: 1 }] });
    assert.equal((await s.adm('POST', `/events/${id}/unpublish`, {})).status, 409);
  });

  await ok('respaldo descargable es una BD SQLite válida', async () => {
    const res = await fetch(s.base + '/api/admin/backup', { headers: { Cookie: s.cookie } });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
    // Ensayo de restauración: la copia se abre con el mismo código y conserva las cuentas
    const restored = join(tmp, 'restaurada.db');
    (await import('node:fs')).writeFileSync(restored, buf);
    const { openDb } = require('../lib/db.js');
    const rdb = openDb(restored, { log() {}, error() {} });
    assert.ok(rdb.prepare('SELECT COUNT(*) n FROM events').get().n >= 3);
    assert.ok(rdb.prepare('SELECT COUNT(*) n FROM guests').get().n >= 4);
    rdb.close();
    assert.equal((await fetch(s.base + '/api/admin/backup')).status, 401);
  });

  /* ---------- cuentas cruzadas ---------- */
  console.log('API · cuentas cruzadas');
  const x = await start('cross');
  await x.login();
  const reg = (tok, name, expenses) => x.call('POST', `/api/company/members?t=${tok}`, { name, expenses });
  const mk = async (name, payersCount, publish = true) => {
    const r = await x.adm('POST', '/events', { kind: 'cross', name, payersCount });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (publish) await x.adm('POST', `/events/${r.data.event.id}/publish`, {});
    return { id: r.data.event.id, tok: tokenOf(r.data.event.links.company) };
  };

  await ok('crear cuenta cruzada: valida participantes, no tiene ítems ni enlace de cumplimentado', async () => {
    assert.equal((await x.adm('POST', '/events', { kind: 'cross', name: 'x', payersCount: 1 })).status, 400);
    assert.equal((await x.adm('POST', '/events', { kind: 'cross', name: 'x', payersCount: 2.5 })).status, 400);
    const r = await x.adm('POST', '/events', { kind: 'cross', name: 'Viaje', payersCount: 2 });
    assert.equal(r.data.event.kind, 'cross');
    assert.equal(r.data.event.status, 'setup');
    assert.equal(r.data.event.links.honoree, undefined);
    assert.equal(r.data.cross.registered, 0);
    const list = (await x.adm('GET', '/events')).data.events;
    assert.equal(list[0].kind, 'cross');
  });

  await ok('ejemplo del enunciado: A pagó 50.000, B pagó 60.000, 2 participantes → A le debe 5.000 a B', async () => {
    const e = await mk('Paseo', 2);
    assert.equal((await x.call('GET', `/api/company?t=${e.tok}`)).data.status, 'open');
    assert.equal((await reg(e.tok, 'A', [{ description: 'Almuerzo', amount: 50000 }])).data.complete, false);
    const r = await reg(e.tok, 'B', [{ description: 'Gasolina', amount: 60000 }]);
    assert.equal(r.status, 200);
    assert.equal(r.data.complete, true);
    assert.equal(r.data.total, 110000);
    assert.equal(r.data.sharePerPerson, 55000);
    assert.deepEqual(r.data.members.map((m) => m.balance), [-5000, 5000]);
    assert.deepEqual(r.data.transfers.map((t) => [t.from.name, t.to.name, t.amount]), [['A', 'B', 5000]]);
    const pub = (await x.call('GET', `/api/company?t=${e.tok}`)).data;
    assert.equal(pub.kind, 'cross');
    assert.deepEqual(pub.transfers, r.data.transfers);
  });

  await ok('3 participantes, el último sin gastos: saldos provisionales hasta que todos se registran', async () => {
    const e = await mk('Casa', 3);
    await reg(e.tok, 'A', [{ description: 'Mercado', amount: 50000 }]);
    const mid = await reg(e.tok, 'B', [{ description: 'Pizza', amount: 40000 }, { description: 'Postre', amount: 20000 }]);
    assert.equal(mid.data.complete, false);
    assert.equal(mid.data.pending, 1);
    assert.deepEqual(mid.data.transfers, [], 'sin transferencias hasta que estén los 3');
    const last = (await reg(e.tok, 'C', [])).data;
    assert.equal(last.complete, true);
    assert.equal(last.members.reduce((a, m) => a + m.share, 0), 110000, 'las cuotas suman exactamente el total');
    assert.deepEqual(last.transfers.map((t) => [t.from.name, t.to.name, t.amount]), [['C', 'B', 23333], ['C', 'A', 13333]]);
  });

  await ok('validaciones: cupos, nombres repetidos, importes y descripciones', async () => {
    const e = await mk('Validar', 2);
    assert.equal((await reg(e.tok, 'Ana', [{ description: 'x', amount: 0 }])).status, 400);
    assert.equal((await reg(e.tok, 'Ana', [{ description: 'x', amount: 10.5 }])).status, 400);
    assert.equal((await reg(e.tok, 'Ana', [{ description: '  ', amount: 100 }])).status, 400);
    assert.equal((await reg(e.tok, '  ', [])).status, 400);
    assert.equal((await reg(e.tok, 'Ana', [{ description: 'ok', amount: 100 }])).status, 200);
    assert.equal((await reg(e.tok, 'ana', [])).status, 409, 'nombre repetido');
    assert.equal((await reg(e.tok, 'Beto', [])).status, 200);
    assert.equal((await reg(e.tok, 'Caro', [])).status, 409, 'ya están todos');
  });

  await ok('estados y tipos: borrador cerrado al público; la cuenta cruzada no usa los flujos de factura', async () => {
    const e = await mk('Estados', 2, false);
    assert.equal((await x.call('GET', `/api/company?t=${e.tok}`)).data.status, 'setup');
    assert.equal((await reg(e.tok, 'A', [])).status, 409);
    await x.adm('POST', `/events/${e.id}/publish`, {});
    assert.equal((await x.call('POST', `/api/company/quote?t=${e.tok}`, { selection: [] })).status, 409);
    assert.equal((await x.call('POST', `/api/company/guests?t=${e.tok}`, { name: 'x', selection: [] })).status, 409);
    const st = (await x.adm('GET', `/events/${e.id}`)).data;
    assert.equal((await x.adm('POST', `/events/${e.id}/unpublish`, {})).data.event.status, 'setup');
    assert.equal(st.event.kind, 'cross');
  });

  await ok('administrador: agregar/quitar gastos y participantes, ajustar N y cerrar solo con todos registrados', async () => {
    const e = await mk('Admin', 3);
    let st = (await x.adm('POST', `/events/${e.id}/members`, { name: 'Ana', expenses: [{ description: 'Taxi', amount: 30000 }] })).data;
    const ana = st.cross.members[0];
    st = (await x.adm('POST', `/events/${e.id}/members/${ana.id}/expenses`, { description: 'Cena', amount: 20000 })).data;
    assert.equal(st.cross.members[0].paid, 50000);
    st = (await x.adm('DELETE', `/events/${e.id}/expenses/${st.cross.members[0].expenses[0].id}`)).data;
    assert.equal(st.cross.members[0].paid, 20000);
    await x.adm('POST', `/events/${e.id}/members`, { name: 'Beto' });
    assert.equal((await x.adm('PUT', `/events/${e.id}`, { name: 'Admin', payersCount: 1 })).status, 400, 'mínimo 2');
    assert.equal((await x.adm('POST', `/events/${e.id}/close`, {})).status, 409, '2 de 3 registrados');
    assert.equal((await x.adm('PUT', `/events/${e.id}`, { name: 'Admin', payersCount: 2 })).data.cross.complete, true);
    assert.equal((await x.adm('PUT', `/events/${e.id}`, { name: 'Admin', payersCount: 3 })).data.cross.complete, false);
    assert.equal((await x.adm('PUT', `/events/${e.id}`, { name: 'Admin', payersCount: 2 })).status, 200);
    assert.equal((await x.adm('POST', `/events/${e.id}/members`, { name: 'Caro' })).status, 409, 'ya completo');
    assert.equal((await x.adm('DELETE', `/events/${e.id}/members/${(await x.adm('GET', `/events/${e.id}`)).data.cross.members[1].id}`)).data.cross.registered, 1);
    await x.adm('POST', `/events/${e.id}/members`, { name: 'Dani', expenses: [{ description: 'Hotel', amount: 100000 }] });
    const closed = (await x.adm('POST', `/events/${e.id}/close`, {})).data;
    assert.equal(closed.event.status, 'closed');
    assert.deepEqual(closed.cross.transfers.map((t) => [t.from.name, t.to.name, t.amount]), [['Ana', 'Dani', 40000]]);
    assert.equal((await x.adm('POST', `/events/${e.id}/members`, { name: 'Tarde' })).status, 409);
    assert.equal((await x.adm('PUT', `/events/${e.id}`, { name: 'x', payersCount: 5 })).status, 409);
    const pub = (await x.call('GET', `/api/company?t=${e.tok}`)).data;
    assert.equal(pub.status, 'closed');
    assert.equal(pub.transfers.length, 1, 'el resultado final sigue visible con el enlace');
  });

  await ok('exportar CSV de una cuenta cruzada incluye saldos y "quién paga a quién"', async () => {
    const e = await mk('Csv', 2);
    await reg(e.tok, 'A', [{ description: 'Cena', amount: 50000 }]);
    await reg(e.tok, 'B', [{ description: '=HYPERLINK("x")', amount: 60000 }]);
    const r = await x.call('GET', `/api/admin/events/${e.id}/export.csv`);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.ok(r.data.includes('Quién paga a quién,De,A,Monto'));
    assert.ok(r.data.includes(',A,B,5000'));
    assert.ok(r.data.includes("'=HYPERLINK"), 'fórmula neutralizada');
  });

  /* ---------- cuentas históricas (BD creada con la versión anterior) ---------- */
  console.log('API · cuenta histórica v1 (migrada)');
  const legacyFile = join(tmp, 'legacy.db');
  {
    const d = new DatabaseSync(legacyFile);
    d.exec(`
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tip_percent REAL NOT NULL DEFAULT 10, status TEXT NOT NULL DEFAULT 'setup', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, name TEXT NOT NULL, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE honoree_items (item_id INTEGER PRIMARY KEY, qty INTEGER NOT NULL);
      CREATE TABLE guests (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, name TEXT NOT NULL, subtotal INTEGER NOT NULL, tip_share INTEGER NOT NULL, honoree_share INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE guest_items (guest_id INTEGER NOT NULL, item_id INTEGER NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY (guest_id, item_id));
      INSERT INTO events (name, tip_percent, status) VALUES ('Vieja', 10, 'open');
      INSERT INTO items (event_id, name, unit_price, qty) VALUES (1,'Pizza',20000,3),(1,'Cerveza',5000,6),(1,'Postre',10000,2);
      INSERT INTO honoree_items VALUES (1,1),(2,2);
    `);
    d.close();
  }
  const l = await start('legacy', { DB_PATH: legacyFile });
  await l.login();

  await ok('la cuenta vieja sobrevive, conserva el cálculo proporcional y sigue cobrando', async () => {
    const list = (await l.adm('GET', '/events')).data.events;
    assert.equal(list.length, 1);
    assert.equal(list[0].rulesVersion, 1);
    const st = (await l.adm('GET', `/events/${list[0].id}`)).data;
    assert.equal(st.event.tipPercent, 10);
    assert.equal(st.summary.invoiceTotal, 121000);
    assert.equal(st.summary.exemptConsumption, 30000);
    const tok = tokenOf(st.event.links.company);
    const items = (await l.call('GET', `/api/company?t=${tok}`)).data.items;
    const id = (n) => items.find((i) => i.name === n).id;
    const r = await l.call('POST', `/api/company/guests?t=${tok}`, { name: 'Ana', selection: [{ itemId: id('Pizza'), qty: 2 }, { itemId: id('Cerveza'), qty: 2 }] });
    assert.equal(r.data.breakdown.kind, 'v1');
    assert.equal(r.data.breakdown.total, 75625);
    assert.equal((await l.adm('PUT', `/events/${list[0].id}`, { name: 'x', payersCount: 1, items: [{ name: 'A', price: 1, qty: 1 }] })).status, 409, 'histórica no editable');
    assert.equal((await l.adm('POST', `/events/${list[0].id}/close`, {})).status, 200);
  });

  /* ---------- límites de peticiones (al final: bloquean al cliente) ---------- */
  console.log('API · límites de peticiones');
  await ok('el login se bloquea tras intentos fallidos y devuelve Retry-After', async () => {
    const r2 = await start('rl');
    let last;
    for (let i = 0; i < 9; i++) last = await fetch(r2.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    assert.equal(await r2.login(), 429, 'ni siquiera la clave correcta mientras dure el bloqueo');
  });

  await ok('las escrituras públicas están limitadas por IP', async () => {
    const r3 = await start('rl2');
    let hit = 0;
    for (let i = 0; i < 60; i++) {
      const r = await r3.call('POST', '/api/company/quote?t=aaaaaaaaaaaaaaaaaaaaaaaa', { selection: [] });
      if (r.status === 429) { hit++; assert.ok(r.headers.get('retry-after')); }
    }
    assert.ok(hit > 0);
  });

  await ok('en producción, el servidor exige contraseña de al menos 10 caracteres', async () => {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', ADMIN_PASSWORD: 'corta', PORT: '3999', DB_PATH: join(tmp, 'p.db') }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => resolve({ code, err }));
    });
    assert.notEqual(out.code, 0);
    assert.match(out.err, /ADMIN_PASSWORD/);
  });

  console.log(`\n${passed} pruebas OK`);
} catch (err) {
  console.error('\n✗ FALLÓ:', err.stack || err.message);
  process.exitCode = 1;
} finally {
  for (const p of servers) p.kill();
  rmSync(tmp, { recursive: true, force: true });
}
