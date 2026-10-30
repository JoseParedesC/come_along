# Cuenta compartida

Monolito para cobrar una factura de varios ítems cuando una persona (el **cumplimentado**) no paga:
su consumo y la propina se reparten entre los demás asistentes, en proporción a lo que consumió cada uno.

- **Node.js ≥ 22.13**, sin dependencias (usa `node:http` y `node:sqlite`).
- Base de datos **SQLite** en `data/cuenta.db` (se crea sola).

## Ejecutar

```bash
npm start            # http://localhost:3000
```

Variables (ver `.env.example`): `PORT`, `DB_PATH`, `ADMIN_PIN`, `CURRENCY` (por defecto `COP`), `LOCALE`.
Si defines `ADMIN_PIN`, `/admin` pide usuario (cualquiera) y contraseña = PIN.

## Flujo

1. `/admin` — registra nombre, % de propina (10 por defecto), ítems, valores y cantidades → **Guardar y habilitar**.
2. `/cumplimentado` — marca lo que consumió. No ve valores ni propina. Al confirmar se habilita `/company`.
3. `/company` — cada invitado marca lo que consumió, pulsa **Ver total**, escribe su nombre y **Guarda**.

## Cálculo

Sea `S` el subtotal de la factura, `T = S × propina%`, `H` lo consumido por el cumplimentado y `Sg = S − H`.
Para un invitado que consumió `c`:

```
total = c + c/Sg × T + c/Sg × H
```

Si todos los invitados registran todo lo restante, la suma de totales es `S + T`.
El servidor recalcula siempre el total (nunca confía en el cliente) y valida unidades disponibles.

## Pruebas

```bash
npm test             # API: 15 comprobaciones sobre un servidor real con BD temporal
python3 test/e2e.py  # UI con Playwright (opcional; requiere playwright + chromium)
```

## Despliegue en Railway

1. Subir el contenido de **esta carpeta** a GitHub (si el repositorio conserva `come_along/` como subcarpeta, configurar **Root Directory** como `/come_along`).
2. Crear servicio desde el repositorio. `railway.json` configura Railpack, `npm start` y healthcheck `/health`.
3. Añadir un **Volume** con mount path `/data` al servicio **antes del primer despliegue con datos reales**.
4. Variables del servicio: `NODE_ENV=production`, `DB_PATH=/data/cuenta.db`, `ADMIN_PIN=<secreto fuerte>`, `CURRENCY=COP`, `LOCALE=es-CO`. Railway inyecta `PORT`.
5. Generar dominio en Networking y verificar `/health`, `/admin`, `/cumplimentado` y `/company`.
6. Mantener **una sola réplica** mientras se use SQLite. Hacer backups periódicos del volumen; el volumen no equivale a un backup.

**Advertencia:** en producción el servidor se niega a iniciar si falta `ADMIN_PIN`. Las rutas públicas `/cumplimentado` y `/company` siguen sin tokens de acceso. No se ha efectuado un despliegue real en una cuenta Railway.
