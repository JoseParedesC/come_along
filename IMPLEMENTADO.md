# Lo implementado (versión 0.9.0)

Monolito Node 22 + SQLite, sin dependencias externas. Esta entrega implementa lo que `FALTANTE.md` marcaba como
pendiente **y que se puede resolver desde el código**; lo que depende de tu cuenta de Railway o de personas
queda explícito en `FALTANTE.md`.

## 1. Reglas de negocio confirmadas (RN-01 … RN-04)

| Regla | Implementación |
|---|---|
| **RN-01** exentos, invitados, nº de pagadores | `/admin` registra el número de participantes que pagan y las listas de **exentos** e **invitados** (categorías distintas, fuera del divisor). Resumen explícito: pagadores, exentos, invitados y total de personas. Los exentos/invitados se registran en `/cumplimentado` (eligen su nombre; sin ver valores ni propina). |
| **RN-02** propina manual | Ítem con casilla **Propina** (`items.is_tip`). Sin campo de porcentaje en cuentas nuevas (`tipPercent` ignorado). No se puede consumir ni asignar; se cuenta una sola vez. |
| **RN-03** redondeo | `ceil(x/100)·100` aplicado **una vez** al total individual, en backend (aritmética entera) y en el ticket. Nunca se cuadra con la factura. Se guardan `calc_exact`, `total` (cobrado) y `rounding_diff`. |
| **RN-04** reparto | `cuota = ceil((consumo + compartido / pagadores)/100)·100`, `compartido = propina + consumo de exentos + consumo de invitados`. Parte igual, no proporcional. El admin ve la diferencia por redondeo y «recaudo − factura». |

Validaciones: cupos (no más registros que pagadores), cierre bloqueado con cuotas pendientes, cero pagadores/propina cero/consumos cero,
ítems de propina no consumibles, nombres repetidos entre exentos e invitados.

**Cuentas históricas**: la migración `user_version 1` es idempotente y no destructiva (copia automática previa `*.pre-v2-*.bak`).
Las cuentas anteriores quedan con `rules_version = 1`, conservan el cálculo proporcional y los totales ya guardados, reciben tokens
de enlace y su «cumplimentado» pasa a una persona exenta (se conserva `honoree_items`). No son editables.

## 2. Funcionalidad pendiente de la lista anterior

- **Editar ítems/cantidades después de habilitar** (`Editar ítems y pagadores`): fusiona por id, recalcula las cuotas guardadas y **rechaza** todo el cambio si alteraría la cuota de alguien ya pagado, si baja de lo ya tomado, si quita un ítem con consumos o si baja los pagadores por debajo de los registrados.
- **Pagos y conciliación**: casilla «Pagado» por participante; tarjetas *Pagado* y *Por conciliar*.
- **Exportar CSV** (UTF-8 con BOM, neutraliza inyección de fórmulas) y **vista de impresión / guardar PDF** (hoja `@media print`).
- **Historial y varias cuentas simultáneas**: selector de cuentas en `/admin`; cada cuenta tiene su propio par de enlaces.
- **Disponibilidad en vivo** en `/company` (sondeo cada 8 s; recorta la selección y avisa si otra persona tomó unidades).

## 3. Seguridad y operación

- **Enlaces con token** aleatorio (144 bits) por cuenta y rol, con **regeneración** desde `/admin`. Sin token o con token inválido no se expone nada.
- **Autenticación de admin** por sesión: cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` en producción) firmada con HMAC, 12 h; bloqueo tras 8 fallos en 10 min; página `/admin/login`; comprobación `Sec-Fetch-Site` en escrituras; contraseña ≥ 10 caracteres obligatoria en producción (`ADMIN_PASSWORD`, alias `ADMIN_PIN`).
- **Límite de peticiones** por IP con `Retry-After` (escrituras públicas 40/min, lecturas 240/min, admin 600/min); respeta `X-Forwarded-For` tras el proxy de Railway.
- **Respaldos**: automáticos (`VACUUM INTO`, cada 6 h, conserva 14), descarga manual desde `/admin`, copia previa a migraciones y ensayo de restauración automatizado en las pruebas.
- Se mantienen `GET /health`, `railway.json`, `.node-version`, escucha en `0.0.0.0`, cierre ordenado con SIGTERM y SQLite en volumen. HSTS en producción.
- `scripts/verify-deploy.mjs`: verifica HTTPS, `/health`, cabeceras, rutas públicas, sesión y cookie `Secure` contra una URL desplegada.

## 4. Calidad

| Prueba | Resultado en este entorno |
|---|---|
| `test/unit.mjs` — 10 unitarias (ejemplo de aceptación 37.400/42.400/32.400, 3.240→3.300, 10.000→10.000, cero pagadores, propiedad con 5.000 casos aleatorios) | ✅ 10/10 |
| `test/migration.mjs` — BD v1 → v2 conserva datos, crea personas/tokens/copia previa, idempotente | ✅ 2/2 |
| `test/smoke.mjs` — 25 pruebas de API sobre servidores reales (sesión, tokens, estados, secreto de precios/propina, RN-04, cupos, pagos, edición, CSV, rotación de enlaces, BD histórica, respaldo y restauración, límites, arranque en producción) | ✅ 25/25 |
| `test/load.mjs` — 300 registros simultáneos por 100 unidades y 40 cupos | ✅ 100/100 unidades, 34/40 cupos, 0 sobreventas; p95 ≈ 640 ms |
| `test/e2e.py` — recorrido completo en Chromium, móvil (390×844) y escritorio (1280×900), incluida disponibilidad en vivo y descarga de CSV | ✅ 2/2 |

Se revisaron capturas de `/admin` (formulario y resumen) y del ticket móvil.
`.github/workflows/ci.yml` ejecuta todo en GitHub Actions (aún **no ejecutado**: no hay acceso a GitHub desde aquí).

## 5. Decisión deliberada

**Moneda con decimales: no se implementa.** Las reglas confirmadas fijan precios enteros en COP (RN-02) y redondeo a la centena (RN-03); admitir decimales las contradiría. Si más adelante se necesita otra moneda, habría que revisar RN-02/RN-03 primero.

## 6. Cambios de documentación

`README.md` (reglas, seguridad, respaldos, restauración, Railway), `REGLAS_NEGOCIO_ACTUALIZACION.md` (estado + decisiones de implementación), `.env.example`, `package.json` 0.9.0 con scripts `test`, `test:unit`, `test:api`, `test:load`, `test:e2e`, `verify:deploy`.
