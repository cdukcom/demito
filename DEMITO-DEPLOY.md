# Demito — configuración de producción

Variables requeridas en el servicio que ejecuta `server.js`:

```text
DATABASE_URL=postgresql://...
SESSION_SECRET=<valor-largo-y-aleatorio>
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
WHATSAPP_FROM=+<numero-aprobado-en-Twilio>
WHATSAPP_SANDBOX_FROM=+14155238886
TWILIO_CONTENT_SID=HX...
WHATSAPP_MODE_ADMIN=production
WHATSAPP_MODE_GUEST=sandbox
WHATSAPP_TO_ADMIN=whatsapp:+57...,whatsapp:+57...
WHATSAPP_TO_GUEST=whatsapp:+57...,whatsapp:+57...

# Actuador RAK2461 (mantener false hasta completar el laboratorio)
RAK2461_ENABLED=false
CHIRPSTACK_API_URL=https://<servidor-chirpstack>
CHIRPSTACK_API_TOKEN=<token-api-con-permiso-de-encolar-downlinks>
RAK2461_DEV_EUI=<dev-eui-del-rak2461-en-minusculas>
RAK2461_TRIGGER_DEV_EUIS=<dev-eui-del-boton-de-panico>
RAK2461_CHANNEL_ID=D1
RAK2461_RELEASE_SECONDS=300
```

`TWILIO_SID` y `TWILIO_TOKEN` siguen funcionando por compatibilidad, pero se prefieren los nombres oficiales anteriores. `WHATSAPP_FROM` debe ser el número propio aprobado como WhatsApp Sender, no el `+14155238886` del Sandbox.

## Cambio de canal y rollback

Cada rol puede usar `production`, `sandbox` o `disabled`. Si las variables de modo no existen, Demito conserva el modo híbrido seguro: Admin en producción e Invitado en Sandbox.

```text
# Híbrido actual
WHATSAPP_MODE_ADMIN=production
WHATSAPP_MODE_GUEST=sandbox

# Rollback rápido: ambos roles por Sandbox
WHATSAPP_MODE_ADMIN=sandbox
WHATSAPP_MODE_GUEST=sandbox

# Migración final: ambos roles por producción
WHATSAPP_MODE_ADMIN=production
WHATSAPP_MODE_GUEST=production
```

El cambio sólo requiere actualizar las variables en Railway y reiniciar el servicio. No modifica MQTT, sensores, destinatarios ni datos persistidos. El Sandbox siempre usa texto libre; la plantilla `TWILIO_CONTENT_SID` sólo se usa en producción cuando el evento proporciona variables.

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

## Actuador RAK2461

Demito puede controlar un RAK2461 de clase C mediante la API de ChirpStack. La integración queda inactiva mientras `RAK2461_ENABLED=false`. Al habilitarla, sólo los botones enumerados en `RAK2461_TRIGGER_DEV_EUIS` accionan el relé.

Regla implementada:

1. Un evento `panic` válido encola un downlink confirmado en `FPort 1` con `D1 01 00` (DO OFF).
2. Demito guarda el estado y la hora de restauración en PostgreSQL.
3. Cinco minutos después encola `D1 01 01` (DO ON). Si la API falla, reintenta cada 30 segundos.
4. Una nueva pulsación válida reinicia el periodo de cinco minutos.
5. El estado se recupera después de un reinicio del servicio.

El canal `D1` corresponde al ejemplo de la guía RAK. Antes de habilitar producción se debe confirmar en IO.Box el `Channel ID` real del equipo. Para la lámpara de laboratorio, RAK documenta el circuito `5V_Out -> lámpara -> COM -> NO -> GND`; se debe habilitar `DC 5V Output`. Para el electroimán final se usará una fuente adecuada y el contacto seco del relé, respetando su tensión y corriente nominales; no debe alimentarse el electroimán desde la salida auxiliar sin verificar su consumo.

Checklist de laboratorio:

- Confirmar variante exacta del RAK2461 (`RS485-DIx4-DOx1` o `RS485-DOx4`) y su banda regional.
- Instalar IO.Box, registrar DevEUI/AppEUI/AppKey, configurar OTAA y Clase C.
- Confirmar `Channel ID`, habilitar el DO y dejar `Output State=Enabled`.
- Registrar el RAK2461 en el mismo ChirpStack que entrega los uplinks a Demito.
- Crear un token de API limitado a encolar downlinks y completar las variables anteriores.
- Probar manualmente `D10100` y `D10101` en `FPort 1`, con downlink confirmado.
- Verificar con lámpara: encendida inicialmente, apagada tras pánico y encendida de nuevo al cumplirse cinco minutos.
