// Prueba de humo end-to-end contra un servidor real con una BD temporal.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'cuenta-'));
const PORT = 3100 + Math.floor(Math.random() * 500);
const PIN = '1234';
const base = `http://127.0.0.1:${PORT}`;
const auth = { Authorization: 'Basic ' + Buffer.from(`admin:${PIN}`).toString('base64') };

const srv = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 't.db'), ADMIN_PIN: PIN },
  stdio: ['ignore', 'pipe', 'inherit'],
});

async function ready() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + '/api/config');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('El servidor no arrancó');
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const admin = (m, p, b) => call(m, p, b, auth);

let passed = 0;
const ok = (name, fn) => fn().then(() => { passed++; console.log('  ✓', name); });

try {
  await ready();
  console.log('Smoke test');

  await ok('sin cuenta: /company y /honoree responden "none"', async () => {
    assert.equal((await call('GET', '/api/company')).data.status, 'none');
    assert.equal((await call('GET', '/api/honoree')).data.status, 'none');
  });

  await ok('/admin exige PIN', async () => {
    assert.equal((await call('GET', '/api/admin/state')).status, 401);
    assert.equal((await call('GET', '/admin')).status, 401);
    assert.equal((await admin('GET', '/api/admin/state')).status, 200);
  });

  let items;
  await ok('admin crea la cuenta (S=110000, propina 10% = 11000)', async () => {
    const r = await admin('POST', '/api/admin/event', {
      name: 'Cena',
      tipPercent: 10,
      items: [
        { name: 'Pizza', price: 20000, qty: 3 },
        { name: 'Cerveza', price: 5000, qty: 6 },
        { name: 'Postre', price: 10000, qty: 2 },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.summary.subtotal, 110000);
    assert.equal(r.data.summary.tip, 11000);
    items = Object.fromEntries(r.data.items.map((i) => [i.name, i.id]));
  });

  await ok('antes de habilitar, el cumplimentado y los invitados están bloqueados', async () => {
    assert.equal((await call('GET', '/api/honoree')).data.status, 'setup');
    assert.equal((await call('GET', '/api/company')).data.status, 'setup');
    const r = await call('POST', '/api/honoree', { selection: [{ itemId: items.Pizza, qty: 1 }] });
    assert.equal(r.status, 409);
  });

  await ok('admin habilita al cumplimentado', async () => {
    assert.equal((await admin('POST', '/api/admin/event/publish', {})).data.event.status, 'honoree');
  });

  await ok('el cumplimentado NO recibe precios ni propina', async () => {
    const r = await call('GET', '/api/honoree');
    const raw = JSON.stringify(r.data).toLowerCase();
    assert.equal(r.data.status, 'honoree');
    assert.ok(!/price|precio|tip|propina|unit/.test(raw), raw);
    assert.equal(r.data.items.length, 3);
    assert.equal((await call('GET', '/api/company')).data.status, 'honoree');
  });

  await ok('el cumplimentado no puede pedir más de lo registrado', async () => {
    const r = await call('POST', '/api/honoree', { selection: [{ itemId: items.Pizza, qty: 9 }] });
    assert.equal(r.status, 409);
  });

  await ok('el cumplimentado registra 1 pizza + 2 cervezas (H=30000) y habilita /company', async () => {
    const r = await call('POST', '/api/honoree', {
      selection: [{ itemId: items.Pizza, qty: 1 }, { itemId: items.Cerveza, qty: 2 }],
    });
    assert.equal(r.status, 200);
    assert.equal((await call('GET', '/api/company')).data.status, 'open');
    assert.equal((await call('POST', '/api/honoree', { selection: [] })).status, 409);
  });

  await ok('invitados ven precios y disponibilidad descontando al cumplimentado', async () => {
    const r = (await call('GET', '/api/company')).data;
    const by = Object.fromEntries(r.items.map((i) => [i.name, i]));
    assert.equal(by.Pizza.available, 2);
    assert.equal(by.Cerveza.available, 4);
    assert.equal(by.Cerveza.price, 5000);
  });

  await ok('"ver total" de A: 50000 + 6875 propina + 18750 cumplimentado = 75625', async () => {
    const r = await call('POST', '/api/company/quote', {
      selection: [{ itemId: items.Pizza, qty: 2 }, { itemId: items.Cerveza, qty: 2 }],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(
      [r.data.breakdown.subtotal, r.data.breakdown.tipShare, r.data.breakdown.honoreeShare, r.data.breakdown.total],
      [50000, 6875, 18750, 75625]
    );
    assert.equal(r.data.breakdown.sharePercent, 62.5);
  });

  await ok('guardar A y B; la suma recaudada = factura + propina (121000)', async () => {
    const a = await call('POST', '/api/company/guests', {
      name: 'Ana',
      selection: [{ itemId: items.Pizza, qty: 2 }, { itemId: items.Cerveza, qty: 2 }],
    });
    assert.equal(a.data.breakdown.total, 75625);
    const b = await call('POST', '/api/company/guests', {
      name: 'Beto',
      selection: [{ itemId: items.Cerveza, qty: 2 }, { itemId: items.Postre, qty: 2 }],
    });
    assert.equal(b.data.breakdown.total, 45375);
    const s = (await admin('GET', '/api/admin/state')).data;
    assert.equal(s.summary.collected, 121000);
    assert.equal(s.summary.pending, 0);
  });

  await ok('no se puede reclamar lo que ya no está disponible', async () => {
    const r = await call('POST', '/api/company/guests', { name: 'Caro', selection: [{ itemId: items.Pizza, qty: 1 }] });
    assert.equal(r.status, 409);
  });

  await ok('nombre duplicado y nombre vacío se rechazan', async () => {
    assert.equal((await call('POST', '/api/company/guests', { name: 'ana', selection: [{ itemId: items.Cerveza, qty: 0 }] })).status, 400);
    assert.equal((await call('POST', '/api/company/guests', { name: '  ', selection: [] })).status, 400);
  });

  await ok('borrar a un invitado libera sus ítems', async () => {
    const s0 = (await admin('GET', '/api/admin/state')).data;
    const ana = s0.guests.find((g) => g.name === 'Ana');
    await admin('DELETE', `/api/admin/guests/${ana.id}`);
    const c = (await call('GET', '/api/company')).data;
    assert.equal(c.items.find((i) => i.name === 'Pizza').available, 2);
  });

  await ok('cerrar el cobro bloquea nuevos registros', async () => {
    await admin('POST', '/api/admin/event/close', {});
    const r = await call('POST', '/api/company/guests', { name: 'Tarde', selection: [{ itemId: items.Pizza, qty: 1 }] });
    assert.equal(r.status, 409);
    assert.equal((await call('GET', '/api/company')).data.status, 'closed');
  });

  console.log(`\n${passed} pruebas OK`);
} catch (err) {
  console.error('\n✗ FALLÓ:', err.message);
  process.exitCode = 1;
} finally {
  srv.kill();
  rmSync(dir, { recursive: true, force: true });
}
