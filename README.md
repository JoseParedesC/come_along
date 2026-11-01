# Cuenta compartida (Come Along)

Monolito para cobrar una factura de varios ítems. Cada **participante que paga** cubre su consumo más una
parte **igual** de la propina y del consumo de **exentos** e **invitados**; la cuota se redondea hacia arriba
a la centena. Sin dependencias externas: **Node.js ≥ 22.13** (`node:http`, `node:sqlite`) y SQLite.

## Ejecutar

```bash
export ADMIN_PASSWORD='una-clave-larga'   # opcional en local; obligatoria (≥ 10 caracteres) en producción
npm start                                  # http://localhost:3000  →  /admin
```

Variables (ver `.env.example`): `PORT`, `HOST`, `DB_PATH`, `ADMIN_PASSWORD` (alias `ADMIN_PIN`), `SESSION_SECRET`,
`CURRENCY`, `LOCALE`, `BACKUP_DIR`, `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`, `TRUST_PROXY`, `RATE_LIMIT`.

## Flujo

1. **`/admin`** (inicio de sesión con contraseña): crea la cuenta con nombre, **número de participantes que pagan**,
   listas de **exentos** e **invitados** (no cuentan como pagadores) y los ítems con valor y cantidad.
   La propina es un ítem más marcado como **Propina** (sin porcentaje). **Guardar y habilitar**.
   Se pueden manejar **varias cuentas a la vez**; cada una tiene sus propios enlaces.
2. **`/cumplimentado?t=…`**: exentos e invitados eligen su nombre y marcan lo que consumieron
   (no ven valores ni propina). Al registrarse todos, se abre el cobro.
3. **`/company?t=…`**: cada participante marca su consumo, pulsa **Ver total**, escribe su nombre y guarda.
   La disponibilidad se actualiza sola cada 8 s.
4. **`/admin`**: seguimiento, marcar **pagado**, editar ítems/pagadores (recalcula), exportar **CSV**,
   **imprimir / guardar PDF**, descargar **respaldo**, cerrar el cobro.

Los enlaces con token (`?t=`) se muestran en `/admin`; se pueden **regenerar** si se filtran.

## Cuentas cruzadas (nuevo en 0.10.0)

Segundo tipo de cuenta, para gastos compartidos entre amigos donde **cada quien paga algo de su bolsillo**.
Al crear una cuenta en `/admin` eliges **Factura con propina** o **Cuentas cruzadas**.

1. El admin define el **número de participantes** (N, mínimo 2) y habilita la cuenta.
2. Cada participante abre su enlace `/company?t=…`, escribe su nombre y registra lo que pagó
   (uno o varios gastos con descripción e importe; puede no haber pagado nada).
3. Se **suma todo y se divide en partes iguales entre N**. `saldo = pagó − su parte`.
4. Cuando están los N registrados aparece **quién le debe a quién**, con el menor número de pagos posible
   (a lo sumo N − 1). Ejemplo: A pagó 50.000 y B 60.000, N = 2 → total 110.000, parte 55.000 → **A le debe 5.000 a B**.

Antes de que se registren todos se ven los saldos **provisionales** (marcados con `*`) pero no los pagos.
El admin puede registrar gastos y participantes por otros, quitar gastos, ajustar el nombre o N, exportar CSV,
imprimir y cerrar (solo con los N registrados). Tras cerrar, el enlace sigue mostrando el resultado final.

Aritmética entera, **al peso** (no se redondea a la centena: eso rompería la suma cero entre quien debe y a quien le deben).
Si el total no es divisible entre N, los pesos sobrantes los asumen los primeros registrados, de modo que las cuotas suman
exactamente el total.

## Cálculo de la factura (RN-04)

```
compartido = propina (ítems is_tip) + consumo de exentos + consumo de invitados
cuota      = ceil( (consumo + compartido / pagadores) / 100 ) × 100     ← redondeo una sola vez
```

No se reparte proporcionalmente al consumo ni se cuadra el recaudo con la factura: el administrador ve la
diferencia por redondeo. Ejemplo: consumos 25.000 / 30.000 / 20.000, exento 15.000, invitado 10.000, propina 12.000
→ cuotas **37.400 / 42.400 / 32.400** (recaudo 112.200 vs. factura 112.000, diferencia 200).

Las cuentas creadas con la versión anterior (propina % y reparto proporcional) se **migran sin perder datos**,
conservan su cálculo y no son editables.

## Seguridad y operación

- Sesión de administrador por cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` en producción), firmada con HMAC; bloqueo tras
  8 intentos fallidos en 10 min; comprobación `Sec-Fetch-Site` en escrituras.
- Enlaces públicos con **token aleatorio** de 144 bits por cuenta y rol.
- **Límite de peticiones** en memoria por IP (escrituras públicas 40/min, lecturas 240/min, admin 600/min). Válido para **una sola réplica**.
- CSP estricta, HSTS en producción, sin `innerHTML`, límite de 1 MB por petición.
- **Respaldos**: copia consistente (`VACUUM INTO`) cada `BACKUP_INTERVAL_HOURS` en `BACKUP_DIR` (conserva `BACKUP_KEEP`),
  copia automática previa a la migración, y descarga manual desde `/admin`.
  ⚠️ Una copia en el **mismo volumen** no protege contra perder el volumen: descarga respaldos con regularidad y guárdalos fuera.
- **Restaurar**: detén el servicio, reemplaza `DB_PATH` por la copia (`.db`) y vuelve a iniciar; la migración es idempotente.

## Despliegue en Railway

1. Subir el contenido de **esta carpeta** a GitHub (si el repositorio la conserva como subcarpeta, configurar **Root Directory**).
2. Crear el servicio desde el repositorio. `railway.json` configura Railpack, `npm start` y healthcheck `/health`; `.node-version` fija Node 22.
3. Añadir un **Volume** con mount path `/data` **antes** de usar datos reales.
4. Variables: `NODE_ENV=production`, `DB_PATH=/data/cuenta.db`, `BACKUP_DIR=/data/backups`, `ADMIN_PASSWORD=<secreto ≥ 10 caracteres>`, `CURRENCY=COP`, `LOCALE=es-CO`. Railway inyecta `PORT`.
5. Generar dominio en *Networking* y ejecutar:
   ```bash
   npm run verify:deploy -- https://tu-app.up.railway.app 'tu-contraseña'
   ```
6. Comprobar a mano la **persistencia**: crear una cuenta, redesplegar y confirmar que sigue ahí.
7. Mantener **una sola réplica** (SQLite + límite de peticiones en memoria).

En producción el servidor **no arranca** si falta `ADMIN_PASSWORD` o tiene menos de 10 caracteres.

## Pruebas

```bash
npm test               # 21 unitarias/migración + 32 de API (servidores reales con BD temporal)
npm run test:load      # 300 registros simultáneos compitiendo por 100 unidades
python3 test/e2e.py    # UI con Playwright (BROWSERS=chromium,firefox,webkit; SHOTS_DIR=capturas/)
```

CI en `.github/workflows/ci.yml` (Node 22; E2E en Chromium, Firefox y WebKit).
