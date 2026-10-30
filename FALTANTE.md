# Lo que falta (≈ 20 %)

## Reglas antiguas que deben reemplazarse
- **Reparto antiguo**: hoy es proporcional al consumo. Reemplazar por consumo propio + reparto igual de gastos compartidos entre pagadores.
- **Propina antigua**: eliminar cálculo porcentual para cuentas nuevas; introducir ítems manuales marcados como propina.
- **Redondeo antiguo**: sustituir por redondeo hacia arriba a la centena; NO cuadrar el residuo.

## Funcionalidad
- Editar ítems/cantidades **después** de habilitar (hoy exige volver a edición antes de que el cumplimentado registre).
- Marcar invitados como **pagado** / conciliar pagos.
- Exportar resumen (CSV/PDF) y vista de impresión para el organizador.
- Historial navegable de cuentas anteriores (los datos ya se guardan; falta la pantalla) y varias cuentas simultáneas.
- Moneda con decimales (hoy los valores son enteros).
- Actualización en vivo de unidades disponibles en `/company` (hoy se valida al "Ver total" y al guardar).

## Seguridad y operación
- Enlaces con **token único** para `/cumplimentado` y `/company` (hoy cualquiera con la URL puede entrar) y autenticación de administrador más robusta que un PIN.
- Límite de peticiones (rate limiting) y respaldo automático de la BD.
- Despliegue real en Railway y comprobación del dominio HTTPS (la guía y configuración Railway ya están implementadas; Dockerfile no es necesario con Railpack).

## Calidad
- Capturas y revisión en escritorio y otros navegadores (solo se revisó Chromium en viewport móvil).
- Pruebas de accesibilidad con lector de pantalla y pruebas de carga/concurrencia.
- Integrar `test/e2e.py` a una CI.


## Pendiente de operación en Railway (2026-10-30)
- Crear el servicio y conectar el repositorio GitHub.
- Crear y montar el volumen persistente en `/data`; establecer `DB_PATH=/data/cuenta.db`.
- Configurar un `ADMIN_PIN` secreto y `NODE_ENV=production`; asignar dominio público.
- Verificar el healthcheck, las tres pantallas y la persistencia tras un redeploy.
- Configurar backups externos y ensayar recuperación de SQLite; mantener una réplica.
- Rate limiting, autenticación más robusta y tokens de acceso públicos continúan pendientes.

## Nuevas reglas de negocio confirmadas (2026-10-30)
- **PENDIENTE DE IMPLEMENTAR:** `/admin` debe registrar exentos, invitados y número de participantes que pagan (excluyendo invitados).
- **PENDIENTE DE IMPLEMENTAR:** propina como ítem manual marcado `is_tip`, sin porcentaje automático.
- **PENDIENTE DE IMPLEMENTAR:** cuota final redondeada hacia arriba al múltiplo de 100; no cuadrar al peso.
- **CONFIRMADO, PENDIENTE DE IMPLEMENTAR:** cada pagador paga su consumo individual más una cuota IGUAL de propina manual + consumos de exentos + consumos de invitados. Divisor: solo pagadores; redondeo final a la centena superior.
- Plan y criterios de aceptación: `REGLAS_NEGOCIO_ACTUALIZACION.md`.
