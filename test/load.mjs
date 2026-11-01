// Concurrencia: muchos participantes a la vez compiten por unidades limitadas.
// Verifica que no se sobrevenda, que no se superen los cupos y que cada cuota sea múltiplo de 100.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'load-'));
const PORT = 4200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;
const PASS = 'clave-de-carga-123';
const PAYERS = 40, UNITS = 100, ATTEMPTS = 300;

const srv = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(tmp, 'l.db'), ADMIN_PASSWORD: PASS, RATE_LIMIT: 'off', BACKUP_INTERVAL_HOURS: '0' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const adm = (m, p, b) => fetch(base + '/api/admin' + p, { method: m, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());

  const ev = await adm('POST', '/events', { name: 'Carga', payersCount: PAYERS, items: [{ name: 'Menú', price: 3300, qty: UNITS }, { name: 'Propina', price: 9999, qty: 1, isTip: true }] });
  await adm('POST', `/events/${ev.event.id}/publish`, {});
  const tok = new URL(ev.event.links.company, base).searchParams.get('t');
  const itemId = ev.items.find((i) => i.name === 'Menú').id;

  const lat = [];
  const attempt = async (n) => {
    const t0 = performance.now();
    const r = await fetch(`${base}/api/company/guests?t=${tok}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Persona ${n}`, selection: [{ itemId, qty: 1 + (n % 5) }] }),
    });
    lat.push(performance.now() - t0);
    return r.status;
  };
  const t0 = performance.now();
  const statuses = await Promise.all(Array.from({ length: ATTEMPTS }, (_, n) => attempt(n)));
  const wall = performance.now() - t0;

  const st = await adm('GET', `/events/${ev.event.id}`);
  const okCount = statuses.filter((s) => s === 200).length;
  const claimed = st.guests.reduce((a, g) => a + g.items.reduce((b, i) => b + i.qty, 0), 0);
  const menu = st.items.find((i) => i.name === 'Menú');

  assert.equal(okCount, st.guests.length, 'cada 200 corresponde a un registro guardado');
  assert.ok(okCount <= PAYERS, `no más de ${PAYERS} participantes (hubo ${okCount})`);
  assert.ok(claimed <= UNITS, `no se sobrevendieron unidades (${claimed}/${UNITS})`);
  assert.equal(menu.guestsQty, claimed);
  assert.ok(menu.available >= 0);
  assert.ok(st.guests.every((g) => g.total % 100 === 0), 'todas las cuotas son múltiplos de 100');
  assert.ok(statuses.every((s) => s === 200 || s === 409), `solo 200 o 409, hubo: ${[...new Set(statuses)]}`);

  lat.sort((a, b) => a - b);
  console.log(`Carga OK: ${ATTEMPTS} intentos simultáneos → ${okCount} aceptados, ${statuses.length - okCount} rechazados (409)`);
  console.log(`  unidades asignadas ${claimed}/${UNITS} · cupos usados ${okCount}/${PAYERS}`);
  console.log(`  tiempo total ${wall.toFixed(0)} ms · p50 ${lat[Math.floor(lat.length * 0.5)].toFixed(0)} ms · p95 ${lat[Math.floor(lat.length * 0.95)].toFixed(0)} ms`);
} catch (e) {
  console.error('✗ FALLÓ:', e.message);
  process.exitCode = 1;
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}
