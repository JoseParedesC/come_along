# Lo que falta (≈ 20 %)

## Decisiones de negocio por confirmar
- **Regla de reparto**: hoy es *proporcional al consumo* de cada invitado. Falta el modo **partes iguales** (dividir entre N asistentes) si es lo que se necesita.
- **Base de la propina**: se calcula sobre toda la factura (incluye lo del cumplimentado). Confirmar que es lo esperado.
- **Redondeo**: cada parte se redondea al peso; la suma puede diferir unos pesos del total exacto. Falta repartir el residuo (método del mayor resto) si se quiere cuadrar al peso.

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
- Dockerfile / guía de despliegue y HTTPS.

## Calidad
- Capturas y revisión en escritorio y otros navegadores (solo se revisó Chromium en viewport móvil).
- Pruebas de accesibilidad con lector de pantalla y pruebas de carga/concurrencia.
- Integrar `test/e2e.py` a una CI.
