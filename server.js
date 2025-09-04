// server.js
const express = require("express");
const bodyParser = require("body-parser");

// --- Twilio ---
const twilioSid   = process.env.TWILIO_SID;
const twilioToken = process.env.TWILIO_TOKEN;
const waFrom      = process.env.WHATSAPP_FROM; // ej: "whatsapp:+14155238886"
const waToList    = (process.env.WHATSAPP_TO || "").split(",").map(s => s.trim()).filter(Boolean);

// Secreto opcional para el webhook:
const hookSecret  = process.env.WEBHOOK_SECRET || ""; // si lo defines, ChirpStack debe mandar header x-secret


// --- Mapa de casas (DevEUI en minúsculas) ---
const HOUSE_MAP = {
  "ffffff100004f749": "Casa Triángulo",
  "ffffff100004f737": "Casa Cuadrado",
};
function houseName(devEui, fallback) {
  const key = String(devEui||"").toLowerCase();
  return HOUSE_MAP[key] || fallback || devEui || "Dispositivo";
}

// --- Anti-duplicados para pánico (por devEUI) ---
const PANIC_TTL_MS = 30 * 1000;
const lastPanic = new Map(); // devEui -> { t: ms, fCnt }

function allowPanic(devEui, fCnt) {
  const now = Date.now();
  const prev = lastPanic.get(devEui);
  if (prev && (prev.fCnt === fCnt || (now - prev.t) < PANIC_TTL_MS)) {
    return false; // duplicado (mismo frame o muy seguido)
  }
  lastPanic.set(devEui, { t: now, fCnt: fCnt ?? -1 });
  return true;
}

// Mensaje humano
function formatHuman({ event, house, devName, devEui, fCnt, battery_mv }) {
  let title, tipo;
  if (event === "panic")       { title = "🚨 *Alerta de Pánico*";        tipo = "Botón de Pánico"; }
  else if (event === "wall_remove") { title = "⚠️ *Alerta: Desmonte de Pared*"; tipo = "Desmonte de Pared"; }
  else if (event === "wall_restore"){ title = "✅ *Montado / Restaurado*";     tipo = "Restaurado"; }
  else if (event === "low_battery"){ title = "🔋 *Batería baja*";              tipo = "Batería baja"; }
  else                            { title = "ℹ️ Evento";                       tipo = event || "N/A"; }

  const lines = [
    title,
    `Lugar: *${house}*`,
    `Tipo: ${tipo}`,
    `Dispositivo: *${devName}* (${devEui})`,
    (typeof fCnt === "number") ? `Frame: ${fCnt}` : null,
    (typeof battery_mv === "number") ? `Batería: ${(battery_mv/1000).toFixed(2)} V` : null,
    `Hora: ${nowBogota()} (Bogotá)`,
  ];
  return lines.filter(Boolean).join("\n");
}

// Resolver evento desde el codec nuevo (o compatibilidad vieja)
function resolveEvent(obj) {
  if (obj?.event) return obj.event;            // preferimos el codec TLV
  if (obj?.panic === true) return "panic";     // compatibilidad
  return null;
}

let twilioClient = null;
if (twilioSid && twilioToken) {
  twilioClient = require("twilio")(twilioSid, twilioToken);
}

const app  = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.json({ limit: "1mb" }));

// util: hora local Bogotá
function nowBogota() {
  return new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
}

// util: log compacto
function log(...args) {
  console.log(`[${nowBogota()}]`, ...args);
}

// -------- health ----------
app.get("/health", (_, res) => res.send("ok"));

// -------- prueba Twilio ----------
app.post("/test/whatsapp", async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(500).json({ ok:false, error: "Twilio no está configurado (TWILIO_SID/TWILIO_TOKEN)" });
    }
    const to = (req.body?.to || waToList[0] || "").trim();
    const body = req.body?.body || "Mensaje de prueba ✅";

    if (!to || !to.startsWith("whatsapp:")) {
      return res.status(400).json({ ok:false, error: "Falta 'to' (formato whatsapp:+57...)" });
    }
    if (!waFrom) {
      return res.status(400).json({ ok:false, error: "Falta WHATSAPP_FROM" });
    }

    const msg = await twilioClient.messages.create({ from: waFrom, to, body });
    log("Twilio OK test ->", to, msg.sid);
    res.json({ ok: true, sid: msg.sid });
  } catch (err) {
    log("Twilio ERROR test:", err.message);
    res.status(500).json({ ok:false, error: err.message });
  }
});

// -------- webhook ChirpStack ----------
app.post("/uplink", async (req, res) => {
  try {
    // Seguridad opcional
    if (hookSecret) {
      const got = req.get("x-secret") || "";
      if (got !== hookSecret) {
        log("Webhook rechazado: x-secret inválido");
        return res.status(401).json({ ok:false, error:"unauthorized" });
      }
    }

    // "event" de ChirpStack (join, up, ack...), lo usamos solo para log
    const event = (req.query.event || req.get("x-event") || "").toLowerCase() || "up";
    const body  = req.body || {};

    // Log compacto del JSON recibido
    try { console.log("RAW UPLINK:", JSON.stringify(body).slice(0, 4000)); } catch {}

    // -------- Info del dispositivo (más robusta) --------
    const devEui  = body?.deviceInfo?.devEui || body?.deviceInfo?.devEUI || "UNKNOWN";
    const devName =
      body?.deviceInfo?.deviceName || // ChirpStack suele mandar "deviceName"
      body?.deviceInfo?.name ||       // por si en alguna versión llega "name"
      devEui;

    // fCnt (contador de frame) si viene
    const fCnt = body?.fCnt ?? body?.fCntUp ?? body?.uplinkMetaData?.fCnt ?? null;

    // -------- Decodificación desde el codec --------
    let obj = body?.object || body?.decoded || null;

    if (!obj && typeof body?.data === "string") {
      try {
        const buf = Buffer.from(body.data, "base64");
        obj = { raw_len: buf.length };
      } catch { /* no-op */ }
    }

    // 1) Resolver el tipo de evento
    const eventKey = resolveEvent(obj);

    // 2) Anti-duplicados SOLO para pánico
    if (eventKey === "panic" && !allowPanic(devEui, fCnt)) {
      log("Pánico duplicado (TTL) -> omitido", devEui, fCnt);
      return res.json({ ok:true, skipped: "panic dedup" });
    }

    log(`Uplink (${event}) dev=${devName}/${devEui} fCnt=${fCnt} event=${eventKey} obj=`, obj);

    // 3) Política de notificación
    // Enviar WhatsApp para: panic, wall_remove, wall_restore
    // No enviar: alive, low_battery
    if (!eventKey || eventKey === "alive" || eventKey === "low_battery") {
      return res.json({ ok:true, skipped: eventKey || "no_event" });
    }

    // Verificación Twilio
    if (!twilioClient || !waFrom || waToList.length === 0) {
      log("No se envía WhatsApp: falta TWILIO_SID/TWILIO_TOKEN/WHATSAPP_FROM/WHATSAPP_TO");
      return res.json({ ok:true, warn:"twilio not configured" });
    }

    // Texto humano (incluye casa por DevEUI y batería si vino del codec)
    const text = formatHuman({
      event: eventKey,
      house: houseName(devEui, devName),
      devName,
      devEui,
      fCnt,
      battery_mv: obj?.battery_mv,
    });

    // Envío a todos los destinatarios
    const results = [];
    for (const to of waToList) {
      try {
        const msg = await twilioClient.messages.create({ from: waFrom, to, body: text });
        log("Twilio OK ->", to, msg.sid);
        results.push({ to, sid: msg.sid, ok:true });
      } catch (err) {
        log("Twilio ERROR ->", to, err.message);
        results.push({ to, ok:false, error: err.message });
      }
    }

    return res.json({ ok:true, sent: results });
  } catch (err) {
    log("Webhook ERROR:", err.message);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

// 404 amable (útil para ver “Cannot GET”)
app.use((req, res) => {
  res.status(404).send("Not Found");
});

app.listen(port, () => log(`listening on ${port}`));