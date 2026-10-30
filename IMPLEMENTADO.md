# Lo implementado (≈ 80 %)

Aplicación **monolito** en Node 22 + SQLite, sin dependencias externas.

## Rutas y reglas del flujo

| Ruta | Qué hace |
|---|---|
| `/admin` | Crea la cuenta: nombre, % de propina (10 % por defecto), ítems con valor unitario y cantidad. Vista previa de subtotal, propina y total. Botones **Guardar borrador** y **Guardar y habilitar al cumplimentado**. |
| `/cumplimentado` | Solo disponible tras habilitar desde `/admin`. Lista ítems y cantidades **sin precios ni propina** (el API tampoco los envía). Al confirmar, habilita `/company`. |
| `/company` | Solo disponible cuando el cumplimentado ya registró. El invitado ve precios y unidades disponibles, selecciona cantidades, pulsa **Ver total** (ticket con su consumo, su parte de la propina y su parte del consumo del cumplimentado), escribe su nombre y **guarda**. |

Estados: `setup → honoree → open → closed`. El servidor bloquea cualquier acción fuera de su estado.

## Cálculo del total

`total = c + c/Sg × T + c/Sg × H` (c = consumo del invitado, Sg = consumo de quienes pagan, T = propina, H = consumo del cumplimentado). Aritmética entera, redondeo al peso más cercano. Con todos los invitados registrados, lo recaudado = factura + propina (verificado en prueba: 121.000 = 110.000 + 11.000).

## Persistencia (SQLite, `data/cuenta.db`)

Tablas: `events`, `items`, `honoree_items`, `guests`, `guest_items`, con claves foráneas, `CHECK` de rangos e índices. Los totales de cada invitado se guardan como instantánea.

## Integridad y seguridad

- El servidor recalcula totales siempre; valida enteros, rangos y unidades disponibles (descontando cumplimentado e invitados previos), dentro de transacciones `BEGIN IMMEDIATE`.
- Nombre de invitado obligatorio y sin duplicados (sin distinguir mayúsculas).
- `ADMIN_PIN` opcional protege `/admin` y `/api/admin/*` (HTTP Basic, comparación en tiempo constante).
- CSP estricta (`default-src 'self'`), sin `innerHTML` (texto siempre como texto), límite de 1 MB por petición.

## Administración

Resumen con subtotal, propina, total, consumo del cumplimentado, recaudado y por recaudar; tabla de ítems con disponibilidad; lista de invitados con desglose; eliminar un registro (libera sus ítems); volver a editar (antes de que el cumplimentado registre); cerrar el cobro; nueva cuenta; enlaces copiables.

## Verificación realizada

- `npm test`: 15 comprobaciones de API, todas OK (bloqueos por estado, ausencia de precios/propina para el cumplimentado, matemática del reparto, disponibilidad, duplicados, cierre, PIN).
- `python3 test/e2e.py`: recorrido completo en Chromium (viewport móvil 390×844), OK; sin errores de consola. Se revisaron capturas de `/company` y `/admin`.
