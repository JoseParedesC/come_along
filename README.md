# Cuenta compartida (Come Along)

Monolito para cobrar una factura de varios ítems. Cada **participante que paga** cubre su consumo más una
parte **igual** de la propina y del consumo de **exentos** e **invitados**; la cuota se redondea hacia arriba
a la centena. **Node.js ≥ 20**, `node:http` y **PostgreSQL** (única dependencia: `pg`). Sin autenticación de usuarios.

## Ejecutar en local

```bash
npm install
export DATABASE_URL='postgresql://usuario:clave@localhost:5432/come_along'
npm start            # http://localhost:3000  →  /admin
```

Las tablas se crean solas al arrancar (idempotente). Variables (ver `.env.example`): `DATABASE_URL` (obligatoria),
`DATABASE_SSL`, `PG_POOL_MAX`, `PORT`, `HOST`, `NODE_ENV`, `CURRENCY`, `LOCALE`, `TRUST_PROXY`, `RATE_LIMIT`.

## Flujo

1. **`/admin`**: crea la cuenta con nombre, **número de participantes que pagan**, listas de **exentos** e
   **invitados** (no cuentan como pagadores) y los ítems con valor y cantidad. La propina es un ítem más marcado
   como **Propina**. **Guardar y habilitar**. Se pueden manejar **varias cuentas a la vez**; cada una tiene sus enlaces.
2. **`/cumplimentado?t=…`**: exentos e invitados eligen su nombre y marcan lo que consumieron (no ven valores ni propina).
   Al registrarse todos, se abre el cobro.
3. **`/company?t=…`**: cada participante marca su consumo, pulsa **Ver total**, escribe su nombre y guarda.
   La disponibilidad se actualiza sola cada 8 s.
4. **`/admin`**: seguimiento, marcar **pagado**, editar ítems/pagadores (recalcula), exportar **CSV**,
   **imprimir / guardar PDF** y cerrar el cobro.

Los enlaces con token (`?t=`) se muestran en `/admin`; se pueden **regenerar** si se filtran.

## Cálculo (RN-04)

```
compartido = propina (ítems is_tip) + consumo de exentos + consumo de invitados
cuota      = ceil( (consumo + compartido / pagadores) / 100 ) × 100     ← redondeo una sola vez
```

No se reparte proporcionalmente al consumo ni se cuadra el recaudo con la factura: el administrador ve la
diferencia por redondeo. Ejemplo: consumos 25.000 / 30.000 / 20.000, exento 15.000, invitado 10.000, propina 12.000
→ cuotas **37.400 / 42.400 / 32.400** (recaudo 112.200 vs. factura 112.000, diferencia 200).

## Acceso y seguridad

- **No hay inicio de sesión**: `/admin` y `/api/admin/*` son accesibles para cualquiera que conozca la URL del servicio.
  Los enlaces `/cumplimentado` y `/company` se identifican por un **token aleatorio** de 144 bits por cuenta y rol.
- **Límite de peticiones** en memoria por IP (escrituras públicas 40/min, lecturas 240/min, admin 600/min). Válido para **una sola réplica**.
- CSP estricta, HSTS en producción, sin `innerHTML`, límite de 1 MB por petición.
- **Concurrencia**: cada escritura sobre una cuenta bloquea su fila (`SELECT … FOR UPDATE`), así que dos personas no
  pueden tomar la misma unidad ni exceder los cupos de pagadores.

## Despliegue en Railway

1. Sube el contenido de **esta carpeta** a GitHub (si queda en una subcarpeta, configura **Root Directory**).
2. En tu proyecto de Railway: **New → Database → Add PostgreSQL**.
3. **New → GitHub Repo** y elige el repositorio. `railway.json` configura Railpack, `npm start` y el healthcheck `/health`;
   `.node-version` fija Node 22.
4. En el servicio web, pestaña **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referencia al servicio de base de datos; usa la red privada, no necesita TLS).
   - `NODE_ENV` = `production`
   - `CURRENCY` = `COP` y `LOCALE` = `es-CO` (opcionales; son los valores por defecto).
   - Railway inyecta `PORT` por su cuenta.
5. **Settings → Networking → Generate Domain**.
6. Mantén **una sola réplica** (el límite de peticiones vive en memoria).

El servidor reintenta la conexión a PostgreSQL durante ~30 s al arrancar, crea las tablas y recién entonces
empieza a escuchar; `/health` responde 503 si la base de datos deja de responder.

**Respaldos**: ahora dependen de PostgreSQL (copias del servicio de Railway o `pg_dump "$DATABASE_URL" > respaldo.sql`
con la URL pública). Restaurar: `psql "$DATABASE_URL" < respaldo.sql`.
