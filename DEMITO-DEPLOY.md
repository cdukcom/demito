# Demito — configuración de producción

Variables requeridas en el servicio que ejecuta `server.js`:

```text
DATABASE_URL=postgresql://...
SESSION_SECRET=<valor-largo-y-aleatorio>
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
WHATSAPP_FROM=+<numero-aprobado-en-Twilio>
TWILIO_CONTENT_SID=HX...
WHATSAPP_TO_ADMIN=whatsapp:+57...,whatsapp:+57...
WHATSAPP_TO_GUEST=whatsapp:+57...,whatsapp:+57...
```

`TWILIO_SID` y `TWILIO_TOKEN` siguen funcionando por compatibilidad, pero se prefieren los nombres oficiales anteriores. `WHATSAPP_FROM` debe ser el número propio aprobado como WhatsApp Sender, no el `+14155238886` del Sandbox.

## Plantilla de WhatsApp

Crear en Twilio Content Template Builder una plantilla de texto con este contenido y enviarla a aprobación de WhatsApp:

```text
{{1}}
{{2}}
{{3}}
{{4}}

www.fibersas.com - www.duke-villa.com - 2026
```

Guardar el `HX...` aprobado como `TWILIO_CONTENT_SID`. Las variables corresponden a evento, fecha/hora, ubicación escrita y enlace de Google Maps. Sin `TWILIO_CONTENT_SID`, Demito enviará texto libre; esto normalmente solo se entrega dentro de la ventana de atención de 24 horas iniciada por el usuario.

## Acceso web

Abrir `https://demito.duke-villa.com`. La raíz redirige al login y ya no acepta ni muestra `ADMIN_TOKEN` en la URL.

- `invitado`: puerta, temperatura y botón de pánico.
- `admin`: todos los sensores, BLE y configuración de destinatarios.

Los cambios de nombre, ubicación, coordenadas, activación, propietario y umbral se guardan en la tabla `sensor_settings`, creada automáticamente al iniciar. Los destinatarios de cada rol se guardan por separado en `whatsapp_recipients`. El número `whatsapp:+573134991467` es fijo y siempre recibe las alertas de ambos roles.
