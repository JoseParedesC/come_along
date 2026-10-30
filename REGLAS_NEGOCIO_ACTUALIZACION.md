# Actualización de reglas de negocio — Come Along

Fecha: 2026-10-30. Estado: **implementado y probado** (ver `IMPLEMENTADO.md`; pruebas en `test/`).

## RN-01 — Participantes, exentos e invitados

En `/admin`, permitir registrar y editar antes de habilitar la cuenta:
- Cantidad de participantes que pagan (entero no negativo).
- Personas exentas de pago (identificables, si aplica).
- Invitados (identificables, si aplica), que **no se incluyen** en el número de participantes que pagan.
- Resumen explícito: participantes que pagan, exentos, invitados y total de personas.

**DECISIÓN CONFIRMADA:** cada participante pagador asume su propio consumo, más una parte IGUAL de la propina manual y del consumo de todos los exentos e invitados. Los invitados no se incluyen en el divisor. Los exentos tampoco pagan. Exentos e invitados se registran como categorías diferentes.

## RN-02 — Propina como ítem manual

La propina se agrega como una línea más, con nombre, precio entero en COP, cantidad y marca `is_tip` (booleano). No aplicar porcentaje, ni calcularla automáticamente. El total de la cuenta incluye la suma de las líneas marcadas como propina. En la interfaz de `/admin` debe existir un control para marcar cada ítem como propina. No presentar un campo de porcentaje.

**Compatibilidad:** la BD actual contiene `events.tip_percent` y la API recibe `tipPercent`; se requiere migración no destructiva de `items` para añadir `is_tip INTEGER NOT NULL DEFAULT 0`, actualización de API y clientes, y política explícita para eventos históricos con porcentaje (conservar el cálculo antiguo solo para históricos o migrar el importe a una línea con registro auditable). No borrar datos existentes.

## RN-03 — Redondeo al siguiente múltiplo de 100

La cuota final de cada participante pagador se redondea hacia arriba al múltiplo de 100 más próximo (si ya es múltiplo, se conserva). No ajustar el último pago para cuadrar exactamente con la factura.

```js
function redondearCentena(valor) {
  if (!Number.isFinite(valor) || valor < 0) throw new Error('Valor inválido');
  return Math.ceil(valor / 100) * 100;
}
```

Casos: 3240→3300; 5001→5100; 8750→8800; 10000→10000; 0→0.

Registrar por separado el importe calculado antes del redondeo, el importe cobrado y la diferencia por redondeo, para que los informes sean transparentes. El excedente no debe imputarse artificialmente a un consumo.

## Plan de implementación

1. Añadir migraciones idempotentes para nuevos campos/tablas sin destruir cuentas previas.
2. Extender el modelo y validación de `/api/admin` para participantes, exentos, invitados e ítems con `is_tip`.
3. Actualizar `/admin` con campos y resumen; retirar porcentaje de propina.
4. Actualizar cálculo de cuenta para sumar la propina manual una sola vez, sin duplicar su asignación a consumo.
5. Sustituir `computeQuote`: consumo individual del pagador + (propina manual + consumos de exentos + consumos de invitados) / cantidad de pagadores. La parte compartida es IGUAL, no proporcional al consumo. Validar cantidad de pagadores > 0 cuando existan importes por distribuir.
6. Aplicar redondeo de cuota a la centena superior en backend y en la vista previa, manteniendo coherencia.
7. Actualizar `/company`, `/cumplimentado`, informes y cierres para reflejar los nuevos conceptos.
8. Añadir pruebas unitarias, API y end-to-end para exentos, invitados, propina, redondeo, eventos históricos y persistencia Railway.

## Criterios de aceptación

- `/admin` muestra y conserva las cantidades correctas, sin contar invitados como pagadores.
- La propina solo procede de líneas introducidas manualmente y marcadas como tal.
- No se utiliza `tipPercent` en las cuentas nuevas.
- Ninguna cuota a pagar tiene unidades ni decenas distintas de cero.
- Un importe ya múltiplo de 100 no aumenta.
- No se modifica una cuota para igualar artificialmente el total de la factura.
- Eventos existentes y sus registros sobreviven la migración.
- Se mantienen la configuración Railway y `GET /health`. La base de datos es PostgreSQL (`DATABASE_URL`) y la aplicación no tiene autenticación de usuarios.

## Estado del código

RN-01 a RN-04 están implementadas en `lib/split.js` (cálculo), `lib/db.js` (migración), `server.js` (API) y `public/assets/*` (UI). Cobertura: `test/unit.mjs` (ejemplo de aceptación y casos límite), `test/migration.mjs`, `test/smoke.mjs` y `test/e2e.py`.

### Decisiones de implementación

- **Modelo**: tablas `people` (`exempt` | `guest`) y `person_items`. El antiguo «cumplimentado» migra a una persona exenta con su consumo copiado; `honoree_items` se conserva intacta.
- **`/cumplimentado`** atiende a exentos e invitados: cada uno elige su nombre y registra su consumo (sin ver valores ni propina). `/company` se abre cuando todos se registraron; si no hay ninguno, se abre al habilitar.
- **Cupos**: no se aceptan más participantes que el número de pagadores. No se puede cerrar con cuotas pendientes (registrados ≠ pagadores), salvo que no haya ninguno (cancelación).
- **Propina**: ítem con `is_tip`; no se puede consumir ni asignar a nadie y se cuenta una sola vez en los gastos compartidos.
- **Históricos**: las cuentas anteriores quedan con `rules_version = 1`, conservan el cálculo proporcional con porcentaje y no son editables. Las nuevas usan `rules_version = 2` y `tip_percent = 0` (el campo `tipPercent` se ignora).
- **Transparencia**: se guardan `calc_exact` (sin redondeo), `total` (cobrado) y `rounding_diff`. En el ticket, propina y parte de exentos/invitados se muestran truncadas al peso y una línea de «ajuste» absorbe fracciones y redondeo, para que las líneas sumen exactamente el total.
- **Edición posterior**: se recalculan las cuotas guardadas; si el cambio alteraría la cuota de alguien marcado como pagado, se rechaza todo el cambio.
## RN-04 — Reparto definitivo confirmado (2026-10-30)

- **Pagador:** paga exactamente su consumo individual más una parte IGUAL de todos los gastos compartidos.
- **Gastos compartidos:** suma de consumos de exentos, consumos de invitados y todos los ítems marcados como propina manual.
- **Divisor:** número de participantes pagadores registrado en `/admin`, sin incluir invitados ni exentos.
- **Cuota:** `ceil((consumo_individual + gastos_compartidos / numero_pagadores) / 100) * 100`. El redondeo se aplica UNA VEZ al total individual.
- **No** se distribuyen gastos compartidos proporcionalmente al consumo.
- **No** se exige cuadrar el recaudo con el total de la factura; mostrar diferencia por redondeo.
- La propina marcada `is_tip` no debe asignarse como consumo individual ni contarse dos veces.
- Validar coherencia entre cantidad de pagadores y registros de pagadores; no cerrar la cuenta con pagos pendientes de cálculo.

### Ejemplo de aceptación

Tres pagadores consumen 25.000, 30.000 y 20.000 COP; un exento consume 15.000, un invitado 10.000 y la propina manual es 12.000. Los gastos compartidos suman 37.000, y a cada pagador corresponden 12.333,333... COP. Las cuotas finales son **37.400**, **42.400** y **32.400** COP; recaudo 112.200 frente a factura 112.000, diferencia 200 por redondeo.

### Pruebas adicionales obligatorias

- Consumos individuales diferentes con idéntica cuota compartida.
- Invitados y exentos excluidos del divisor, pero incluidos en los gastos compartidos.
- Propina como ítem manual, sin porcentaje.
- Redondeo final 3.240→3.300 y 10.000→10.000.
- Caso de cero pagadores, propina cero y consumos cero.
- Evitar duplicación de propina y preservar cuentas históricas durante migración.

**Estado:** implementado y verificado con las pruebas de este repositorio (ejemplo 37.400 / 42.400 / 32.400, recaudo 112.200, diferencia 200).
