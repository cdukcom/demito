// server.js
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// --- Twilio ---
const twilioSid   = process.env.TWILIO_SID;
const twilioToken = process.env.TWILIO_TOKEN;
const waFrom      = process.env.WHATSAPP_FROM; // ej: "whatsapp:+14155238886"
const waToList    = (process.env.WHATSAPP_TO || "").split(",").map(s => s.trim()).filter(Boolean);
// Secreto opcional para el webhook:
const hookSecret  = process.env.WEBHOOK_SECRET || ""; // si lo defines, ChirpStack debe mandar header x-secret

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

    const event = (req.query.event || req.get("x-event") || "").toLowerCase() || "up";
    const body  = req.body || {};
    
    // Log info recibida via JSON
    try { console.log("RAW UPLINK:", JSON.stringify(body).slice(0, 4000)); } catch {}

    // Info del dispositivo
    const devEui = body?.deviceInfo?.devEui || body?.deviceInfo?.devEUI || "UNKNOWN";
    const devName = body?.deviceInfo?.name || devEui;
    const fCnt = body?.fCnt ?? body?.fCntUp ?? null;

    // Decodificación:
    // 1) Si viene 'object' desde codec (lo preferido)
    let obj = body?.object || body?.decoded || null;

    // 2) Si no hay 'object', intentamos leer 'data' (base64) y revisar bit0
    let panic = false;
    let btnRaw = null;

    if (obj && typeof obj === "object") {
      // Heurística: si trae "panic" lo usamos; si trae btn_raw lo interpretamos
      if (typeof obj.panic === "boolean") {
        panic = obj.panic;
      } else if (typeof obj.btn_raw === "number") {
        btnRaw = obj.btn_raw & 0xff;
        panic = (btnRaw & 0x01) === 1;
      }
    } else if (typeof body?.data === "string") {
      try {
        const buf = Buffer.from(body.data, "base64");
        if (buf.length > 0) {
          btnRaw = buf[0];
          panic  = (btnRaw & 0x01) === 1;
          obj = { btn_raw: btnRaw, panic };
        }
      } catch (e) {
        // sin impacto
      }
    }

    log(`Uplink (${event}) dev=${devName}/${devEui} fCnt=${fCnt} panic=${panic} obj=`, obj);

    // Si no hay pánico, respondemos OK y listo (útil para otras tramas)
    if (!panic) {
      return res.json({ ok:true, skipped:"no panic flag" });
    }

    // Enviar WhatsApp
    if (!twilioClient || !waFrom || waToList.length === 0) {
      log("No se envía WhatsApp: falta TWILIO_SID/TWILIO_TOKEN/WHATSAPP_FROM/WHATSAPP_TO");
      return res.json({ ok:true, warn:"twilio not configured" });
    }

    const text = [
      "🚨 *Alerta de Pánico*",
      `Dispositivo: *${devName}* (${devEui})`,
      fCnt != null ? `Frame: ${fCnt}` : null,
      `Hora: ${nowBogota()} (Bogotá)`,
    ].filter(Boolean).join("\n");

    const results = [];
    for (const to of waToList) {
      try {
        const msg = await twilioClient.messages.create({
          from: waFrom,
          to,
          body: text,
        });
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