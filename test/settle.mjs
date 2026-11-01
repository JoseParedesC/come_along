// Pruebas unitarias de las cuentas cruzadas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { repartir } = createRequire(import.meta.url)('../lib/settle.js');

const m = (name, pagado, id = name) => ({ id, name, pagado });
const net = (r) => Object.fromEntries(r.miembros.map((x) => [x.name, x.saldo]));

test('ejemplo del enunciado: A pagó 50, B pagó 60, 2 participantes → A le debe 5 a B', () => {
  const r = repartir([m('A', 50000), m('B', 60000)], 2);
  assert.equal(r.total, 110000);
  assert.equal(r.cuotaExacta, 55000);
  assert.deepEqual(r.miembros.map((x) => x.cuota), [55000, 55000]);
  assert.deepEqual(net(r), { A: -5000, B: 5000 });
  assert.deepEqual(r.transferencias, [{ from: { id: 'A', name: 'A' }, to: { id: 'B', name: 'B' }, amount: 5000 }]);
  assert.equal(r.completo, true);
});

test('un participante que no pagó nada también debe su parte (3 participantes, C sin gastos)', () => {
  const r = repartir([m('A', 50000), m('B', 60000), m('C', 0)], 3);
  // 110000 / 3 = 36666,67 → cuotas 36667, 36667, 36666 (el resto va a los primeros)
  assert.deepEqual(r.miembros.map((x) => x.cuota), [36667, 36667, 36666]);
  assert.equal(r.miembros.reduce((a, x) => a + x.cuota, 0), 110000);
  assert.deepEqual(net(r), { A: 13333, B: 23333, C: -36666 });
  const pagosDeC = r.transferencias.filter((t) => t.from.name === 'C');
  assert.deepEqual(pagosDeC.map((t) => [t.to.name, t.amount]), [['B', 23333], ['A', 13333]]);
  assert.equal(r.transferencias.length, 2);
});

test('incompleto: se muestran saldos provisionales pero no hay transferencias', () => {
  const r = repartir([m('A', 50000), m('B', 60000)], 3);
  assert.equal(r.completo, false);
  assert.equal(r.sinRegistrar, 1);
  assert.deepEqual(r.transferencias, []);
  assert.equal(r.cuotaExacta, 36666.67);
});

test('todos pagaron lo mismo: no hay deudas', () => {
  const r = repartir([m('A', 30000), m('B', 30000), m('C', 30000)], 3);
  assert.deepEqual(r.transferencias, []);
  assert.deepEqual(Object.values(net(r)), [0, 0, 0]);
});

test('nadie pagó nada: todo en cero', () => {
  const r = repartir([m('A', 0), m('B', 0)], 2);
  assert.equal(r.total, 0);
  assert.deepEqual(r.transferencias, []);
});

test('uno pagó todo: los demás le pagan su parte', () => {
  const r = repartir([m('A', 90000), m('B', 0), m('C', 0)], 3);
  assert.deepEqual(r.transferencias.map((t) => [t.from.name, t.to.name, t.amount]), [['B', 'A', 30000], ['C', 'A', 30000]]);
});

test('entradas inválidas', () => {
  assert.throws(() => repartir([m('A', 1)], 0));
  assert.throws(() => repartir([m('A', 1)], 1.5));
  assert.throws(() => repartir([m('A', 1), m('B', 1)], 1), /más miembros/);
  assert.throws(() => repartir([m('A', -1)], 1));
  assert.throws(() => repartir([m('A', 1.5)], 1));
});

test('propiedad: conservación exacta, pagos positivos y enteros, a lo sumo n−1 y saldos netos correctos', () => {
  let seed = 11;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let k = 0; k < 5000; k++) {
    const n = 2 + rnd(10);
    const miembros = Array.from({ length: n }, (_, i) => m(`P${i}`, rnd(3) === 0 ? 0 : rnd(400000), i));
    const r = repartir(miembros, n);
    assert.equal(r.miembros.reduce((a, x) => a + x.cuota, 0), r.total, 'las cuotas suman el total');
    assert.equal(r.miembros.reduce((a, x) => a + x.saldo, 0), 0, 'los saldos suman cero');
    assert.ok(r.transferencias.length <= n - 1);
    const balance = Object.fromEntries(r.miembros.map((x) => [x.id, x.saldo]));
    for (const t of r.transferencias) {
      assert.ok(Number.isSafeInteger(t.amount) && t.amount > 0);
      assert.notEqual(t.from.id, t.to.id);
      balance[t.from.id] += t.amount; // el deudor paga → su saldo sube
      balance[t.to.id] -= t.amount;   // el acreedor cobra → su saldo baja
    }
    assert.ok(Object.values(balance).every((v) => v === 0), 'tras los pagos todos quedan en cero');
  }
});
