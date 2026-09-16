# CitaNIE Madrid — MVP + monitor seguro

MVP centrado exclusivamente en Madrid y trámites NIE/TIE. La interfaz conserva el flujo visual original y se añade un primer worker Playwright para validar el acceso al portal oficial con un navegador real.

## Qué hace el worker

- Abre el portal oficial ICP+ con Chromium real.
- Busca `MADRID` en los desplegables.
- Busca un trámite compatible con `TOMA DE HUELLA`, `EXPEDICIÓN DE TARJETA` o `TIE`.
- Continúa hasta el formulario de identidad.
- En `SAFE_MODE=true` **se detiene ahí** y no envía datos personales.
- Se detiene inmediatamente si detecta CAPTCHA, reCAPTCHA, hCaptcha, Cl@ve, SMS o verificación humana.
- Si en una prueba autorizada se usa `SAFE_MODE=false` y se proporcionan datos del propio solicitante, puede llegar a la pantalla de disponibilidad.
- Si detecta una cita, devuelve `AVAILABILITY_DETECTED`, pero **no elige ni confirma la cita**.

## Estados principales

- `READY_FOR_IDENTITY`: el flujo funciona hasta identificación.
- `HUMAN_GATE`: hace falta intervención humana.
- `NO_AVAILABILITY`: el portal indica que no hay citas.
- `AVAILABILITY_DETECTED`: existe una pantalla compatible con disponibilidad; no se reserva.
- `PROCEDURE_NOT_FOUND` / `PORTAL_CHANGED`: hay que actualizar selectores.

## Local

```bash
npm install
npx playwright install chromium
npm run check:tie
```

Por defecto corre en `SAFE_MODE=true`.

## API de prueba

```bash
curl -X POST http://localhost:3000/api/check/tie \
  -H "x-monitor-secret: TU_SECRETO"
```

Consultar último resultado:

```bash
curl http://localhost:3000/api/status
```

## Render

Se incluye `render.yaml`. El build instala Chromium de Playwright. Para la primera prueba deja `SAFE_MODE=true`.

## Límites del MVP

Este código no elude CAPTCHA ni otros controles, no reserva automáticamente y no comercializa citas. El servicio debe limitarse a monitorización/alertas y a la asistencia autorizada del propio solicitante.
