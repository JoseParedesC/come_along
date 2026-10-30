'use strict';
/**
 * Cálculo de cuotas (funciones puras, sin I/O).
 *
 * Reglas v2 (RN-01…RN-04, confirmadas 2026-10-30):
 *   cuota = ceil( (consumo + compartido / pagadores) / 100 ) * 100
 *   compartido = propina manual (ítems is_tip) + consumo de exentos + consumo de invitados
 *   pagadores  = solo participantes que pagan (sin exentos ni invitados)
 * El redondeo se aplica UNA sola vez al total individual y nunca se cuadra contra la factura.
 *
 * Reglas v1 (históricas): propina porcentual y reparto proporcional al consumo; se conservan
 * únicamente para cuentas creadas antes de la migración.
 */

const STEP = 100;

function assertInt(name, v) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} inválido`);
}

/** Redondea hacia arriba al siguiente múltiplo de 100 (un múltiplo exacto se conserva). */
function redondearCentena(valor) {
  if (!Number.isFinite(valor) || valor < 0) throw new Error('Valor inválido');
  return Math.ceil(valor / STEP) * STEP;
}

/**
 * @param {{consumo:number, compartido:number, pagadores:number}} p  enteros >= 0
 * @returns {{total:number, exacto:number, diferencia:number, parteCompartida:number}}
 */
function calcularCuota({ consumo, compartido, pagadores }) {
  assertInt('consumo', consumo);
  assertInt('compartido', compartido);
  assertInt('pagadores', pagadores);
  if (pagadores === 0) {
    if (consumo === 0 && compartido === 0) return { total: 0, exacto: 0, diferencia: 0, parteCompartida: 0 };
    throw new Error('Hay importes por cobrar pero no hay pagadores registrados.');
  }
  // Aritmética entera: ceil((consumo*N + compartido) / (N*100)) * 100, sin errores de coma flotante.
  const num = consumo * pagadores + compartido;
  const den = pagadores * STEP;
  const total = Math.floor((num + den - 1) / den) * STEP;
  const exacto = num / pagadores;
  return {
    total,
    exacto: Math.round(exacto * 10000) / 10000,
    diferencia: Math.round((total - exacto) * 10000) / 10000,
    parteCompartida: compartido / pagadores,
  };
}

/** Cálculo histórico (v1): parte proporcional de propina % y de lo consumido por el cumplimentado. */
function cuotaProporcional({ consumo, consumoPagadores, propina, consumoExentos }) {
  const tipShare = consumoPagadores > 0 ? Math.round((consumo * propina) / consumoPagadores) : 0;
  const honoreeShare = consumoPagadores > 0 ? Math.round((consumo * consumoExentos) / consumoPagadores) : 0;
  return { tipShare, honoreeShare, total: consumo + tipShare + honoreeShare };
}

module.exports = { STEP, redondearCentena, calcularCuota, cuotaProporcional };
