# CitaNIE Madrid — monitor seguro de Extranjería

Aplicación centrada en Madrid para los trámites de Extranjería y Policía disponibles en el portal oficial. La interfaz muestra nombres sencillos y conserva, para la automatización, el nombre oficial exacto de cada trámite.

## Qué hace el worker

- Abre directamente la página oficial de Madrid: `https://icp.administracionelectronica.gob.es/icpplustiem/citar?p=28&locale=es`.
- Busca el nombre oficial exacto correspondiente a la opción sencilla elegida por el usuario.
- Incluye los 14 trámites visibles en la selección oficial aportada, desde NIE/TIE hasta asilo, regreso, certificados y casos especiales.
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
