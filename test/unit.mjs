// Pruebas unitarias de las reglas de reparto (RN-03 / RN-04).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { calcularCuota, redondearCentena, cuotaProporcional } = createRequire(import.meta.url)('../lib/split.js');

test('redondeo a la centena superior (RN-03)', () => {
  assert.equal(redondearCentena(3240), 3300);
  assert.equal(redondearCentena(5001), 5100);
  assert.equal(redondearCentena(8750), 8800);
  assert.equal(redondearCentena(10000), 10000);
  assert.equal(redondearCentena(0), 0);
  assert.throws(() => redondearCentena(-1));
  assert.throws(() => redondearCentena(NaN));
});

test('ejemplo de aceptación RN-04: 25.000 / 30.000 / 20.000 + exento 15.000 + invitado 10.000 + propina 12.000', () => {
  const compartido = 15000 + 10000 + 12000;
  assert.equal(compartido, 37000);
  const cuotas = [25000, 30000, 20000].map((consumo) => calcularCuota({ consumo, compartido, pagadores: 3 }));
  assert.deepEqual(cuotas.map((c) => c.total), [37400, 42400, 32400]);
  const recaudo = cuotas.reduce((a, c) => a + c.total, 0);
  assert.equal(recaudo, 112200);
  assert.equal(recaudo - 112000, 200); // diferencia por redondeo; no se cuadra
  assert.ok(Math.abs(cuotas[0].parteCompartida - 12333.3333) < 0.001);
  assert.equal(cuotas[0].exacto, 37333.3333);
  assert.equal(cuotas[0].diferencia, 66.6667);
});

test('consumos distintos con idéntica parte compartida (no proporcional)', () => {
  const a = calcularCuota({ consumo: 10000, compartido: 6000, pagadores: 2 });
  const b = calcularCuota({ consumo: 50000, compartido: 6000, pagadores: 2 });
  assert.equal(a.parteCompartida, b.parteCompartida);
  assert.equal(b.total - a.total, 40000);
});

test('un total que ya es múltiplo de 100 no aumenta', () => {
  assert.equal(calcularCuota({ consumo: 10000, compartido: 0, pagadores: 1 }).total, 10000);
  assert.equal(calcularCuota({ consumo: 8000, compartido: 4000, pagadores: 2 }).total, 10000);
});

test('3.240 -> 3.300 con un solo pagador', () => {
  assert.equal(calcularCuota({ consumo: 3240, compartido: 0, pagadores: 1 }).total, 3300);
});

test('el redondeo se aplica una sola vez al total individual', () => {
  // 1000 + 100/3 = 1033,33 -> 1100 (no 1000 + ceil(33,33) ni redondeos parciales)
  assert.equal(calcularCuota({ consumo: 1000, compartido: 100, pagadores: 3 }).total, 1100);
});

test('casos límite: cero pagadores, propina cero, consumos cero', () => {
  assert.deepEqual(calcularCuota({ consumo: 0, compartido: 0, pagadores: 0 }).total, 0);
  assert.throws(() => calcularCuota({ consumo: 0, compartido: 500, pagadores: 0 }), /no hay pagadores/);
  assert.equal(calcularCuota({ consumo: 5000, compartido: 0, pagadores: 2 }).total, 5000);
  assert.equal(calcularCuota({ consumo: 0, compartido: 0, pagadores: 4 }).total, 0);
  assert.equal(calcularCuota({ consumo: 0, compartido: 1000, pagadores: 4 }).total, 300);
});

test('entradas inválidas', () => {
  assert.throws(() => calcularCuota({ consumo: 1.5, compartido: 0, pagadores: 1 }));
  assert.throws(() => calcularCuota({ consumo: -1, compartido: 0, pagadores: 1 }));
  assert.throws(() => calcularCuota({ consumo: 0, compartido: 0, pagadores: 1.2 }));
});

test('propiedad: la cuota nunca baja del valor exacto, nunca lo supera en 100 o más y es múltiplo de 100', () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let i = 0; i < 5000; i++) {
    const consumo = rnd(500000);
    const compartido = rnd(300000);
    const pagadores = 1 + rnd(12);
    const r = calcularCuota({ consumo, compartido, pagadores });
    const exacto = consumo + compartido / pagadores;
    assert.equal(r.total % 100, 0);
    assert.ok(r.total >= exacto - 1e-6, `${consumo},${compartido},${pagadores}`);
    assert.ok(r.total - exacto < 100 + 1e-6);
  }
});

test('reglas históricas v1 se conservan (proporcional)', () => {
  const r = cuotaProporcional({ consumo: 50000, consumoPagadores: 80000, propina: 11000, consumoExentos: 30000 });
  assert.deepEqual(r, { tipShare: 6875, honoreeShare: 18750, total: 75625 });
});
