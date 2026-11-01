'use strict';
/**
 * Cuentas cruzadas (funciones puras).
 *
 * Cada miembro registra lo que PAGÓ de su bolsillo. Todo se suma y se divide en partes iguales entre
 * `participantes` (número que ingresa el administrador). saldo = pagado − cuota:
 *   saldo > 0  → le deben dinero ·  saldo < 0  → debe dinero.
 *
 * Aritmética entera, sin redondear a la centena: el total = N·q + r; los primeros r miembros (por orden de
 * registro) asumen 1 peso más, de modo que las cuotas suman exactamente el total y los saldos suman 0.
 * Las transferencias se calculan solo cuando ya se registraron los N participantes; resuelven las deudas
 * con a lo sumo (n − 1) pagos (el deudor más grande paga al acreedor más grande).
 */

function liquidar(detalle) {
  const deudores = detalle.filter((d) => d.saldo < 0).map((d, orden) => ({ ...d, resta: -d.saldo, orden }));
  const acreedores = detalle.filter((d) => d.saldo > 0).map((d, orden) => ({ ...d, resta: d.saldo, orden }));
  const porMonto = (a, b) => b.resta - a.resta || a.orden - b.orden;
  deudores.sort(porMonto);
  acreedores.sort(porMonto);
  const pagos = [];
  let i = 0;
  let j = 0;
  while (i < deudores.length && j < acreedores.length) {
    const monto = Math.min(deudores[i].resta, acreedores[j].resta);
    pagos.push({
      from: { id: deudores[i].id, name: deudores[i].name },
      to: { id: acreedores[j].id, name: acreedores[j].name },
      amount: monto,
    });
    deudores[i].resta -= monto;
    acreedores[j].resta -= monto;
    if (deudores[i].resta === 0) i++;
    if (acreedores[j].resta === 0) j++;
  }
  return pagos;
}

/**
 * @param {{id:any,name:string,pagado:number}[]} miembros  en orden de registro; pagado entero >= 0
 * @param {number} participantes  entero >= 1 (≥ miembros.length)
 */
function repartir(miembros, participantes) {
  if (!Number.isSafeInteger(participantes) || participantes < 1) throw new Error('Número de participantes inválido');
  if (miembros.length > participantes) throw new Error('Hay más miembros registrados que participantes');
  for (const m of miembros) {
    if (!Number.isSafeInteger(m.pagado) || m.pagado < 0) throw new Error(`Importe inválido para ${m.name}`);
  }
  const total = miembros.reduce((a, m) => a + m.pagado, 0);
  const q = Math.floor(total / participantes);
  const r = total % participantes;
  const detalle = miembros.map((m, i) => {
    const cuota = q + (i < r ? 1 : 0);
    return { id: m.id, name: m.name, pagado: m.pagado, cuota, saldo: m.pagado - cuota };
  });
  const completo = miembros.length === participantes;
  return {
    total,
    participantes,
    registrados: miembros.length,
    sinRegistrar: participantes - miembros.length,
    cuotaExacta: Math.round((total / participantes) * 100) / 100,
    completo,
    miembros: detalle,
    transferencias: completo ? liquidar(detalle) : [],
  };
}

module.exports = { repartir, liquidar };
