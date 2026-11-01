# Lo que falta

El código y las pruebas automáticas de la lista anterior están implementados (ver `IMPLEMENTADO.md`).
Lo que sigue **no se puede completar desde aquí** o requiere una decisión tuya.

## Operación en Railway (requiere tu cuenta)
- [ ] Crear el servicio y conectar el repositorio de GitHub (Root Directory si aplica).
- [ ] Crear y montar el volumen en `/data`; variables `NODE_ENV=production`, `DB_PATH=/data/cuenta.db`, `BACKUP_DIR=/data/backups`, `ADMIN_PASSWORD` (≥ 10 caracteres).
- [ ] Asignar dominio público y ejecutar `npm run verify:deploy -- <URL> '<contraseña>'` (el script está probado solo contra un servidor local, no contra Railway).
- [ ] Verificar el healthcheck y la **persistencia tras un redeploy** (a mano).
- [ ] **Respaldos externos**: los automáticos viven en el mismo volumen. Falta programar una descarga periódica fuera de Railway (p. ej. un cron que consuma `/api/admin/backup`) y ensayar la restauración **en tu entorno** (en las pruebas se ensaya contra una copia local).
- [ ] Mantener **una sola réplica**: el límite de peticiones y SQLite son locales al proceso.

## Seguridad: límites conocidos
- La autenticación es una contraseña única con sesión firmada. No hay usuarios individuales, 2FA ni SSO.
- Los tokens de enlace no caducan (se pueden regenerar a mano). Quien tenga el enlace de `/cumplimentado` puede registrar a cualquier persona pendiente de la lista; quien tenga el de `/company` puede registrarse mientras haya cupos.
- La sesión no se puede revocar de forma individual (cambiar `ADMIN_PASSWORD`/`SESSION_SECRET` invalida todas).

## Calidad: pendiente de ejecutar o de hacer por personas
- [ ] Ejecutar el CI de GitHub Actions por primera vez (el flujo está escrito, pero no se pudo correr).
- [ ] Firefox y WebKit: no estaban instalados en este entorno; solo se probó Chromium (el CI los cubrirá).
- [ ] Pruebas de accesibilidad con **lector de pantalla** real (se usaron etiquetas ARIA, foco visible y objetivos táctiles de 44 px, pero no se verificó con NVDA/VoiceOver/TalkBack).
- [ ] Prueba de carga contra el despliegue real (la actual es local: 300 solicitudes simultáneas).
- [ ] Revisión visual en tablets y en pantallas muy pequeñas (se revisó 390 px y 1280 px).

## Cuentas cruzadas: límites y pendientes
- [ ] **Marcar un pago como saldado** («Ana ya le pagó a Beto»): hoy los pagos se calculan pero no se registra si se hicieron. Como se derivan de los saldos, habría que guardarlos y decidir qué pasa si se edita un gasto después.
- [ ] **Reparto desigual** (partes distintas por persona, p. ej. quien no bebió): hoy es siempre en partes iguales entre N, como se pidió.
- [ ] Un participante **no puede editar sus gastos** después de guardarlos (solo el admin). Cualquiera con el enlace puede registrarse con cualquier nombre; el dispositivo solo recuerda quién se registró.
- [ ] No se rastrea **quién compró para quién**: solo sumas por persona (los pagos son los mínimos, no «cruces» uno a uno).
- [ ] Decisión tuya: el redondeo es **al peso**, no a la centena (RN-03 sigue solo en facturas). Redondear cuotas a la centena rompería la suma cero entre deudores y acreedores; si lo necesitas, hay que definir quién absorbe la diferencia.
- [ ] No hay prueba de carga específica para cuentas cruzadas (la de 300 registros simultáneos cubre las facturas).

## Mejoras opcionales (no estaban en la lista)
- Aviso al organizador cuando todos los pagadores se registran; recordatorios de pago.
- Vista pública de «mi cuenta» para que un participante recupere su total después de cerrar la pestaña.
- Edición de las listas de exentos e invitados después de habilitar.

## Descartado a propósito
- **Moneda con decimales**: contradice RN-02 (precio entero en COP) y RN-03 (redondeo a la centena).
