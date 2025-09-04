// server.js
const express = require("express");
const bodyParser = require("body-parser");

// --- Twilio ---
const twilioSid   = process.env.TWILIO_SID;
const twilioToken = process.env.TWILIO_TOKEN;
const waFrom      = process.env.WHATSAPP_FROM; // ej: "whatsapp:+14155238886"

// --- Destinatarios dinámicos (en memoria) ---
const ALWAYS_ON = new Set(["whatsapp:+573134991467"]); // fijo por código
const waToInit = (process.env.WHATSAPP_TO || "").split(",").map(s => s.trim()).filter(Boolean);
const recipients = new Set([...waToInit, ...ALWAYS_ON]);

function getRecipients() {
  return Array.from(new Set([...ALWAYS_ON, ...recipients]));
}

// Secreto opcional para el webhook:
const hookSecret  = process.env.WEBHOOK_SECRET || ""; // si lo defines, ChirpStack debe mandar header x-secret
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// --- Mapa de casas (DevEUI en minúsculas) ---
const HOUSE_MAP = {
  "ffffff100004f749": "Casa Triángulo",
  "ffffff100004f737": "Casa Cuadrado",
};
function houseName(devEui, fallback) {
  const key = String(devEui||"").toLowerCase();
  return HOUSE_MAP[key] || fallback || devEui || "Dispositivo";
}

// --- Normalización de números de Whatsapp ---

function normalizeWhatsApp(input) {
  let s = String(input || "").trim();
  if (s.toLowerCase().startsWith("whatsapp:")) s = s.slice("whatsapp:".length);
  s = s.replace(/[^\d+]/g, "");
  if (!s.startsWith("+")) {
    if (s.startsWith("57") && s.length >= 12) s = "+" + s;
    else if (s.length === 10 && s[0] === "3") s = "+57" + s;
    else return null;
  }
  return "whatsapp:" + s;
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
app.use(bodyParser.urlencoded({ extended: false }));

// util: hora local Bogotá
function nowBogota() {
  return new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
}

// util: log compacto
function log(...args) {
  console.log(`[${nowBogota()}]`, ...args);
}

// ------ Acceso MiniWeb seguro -----

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const t = req.query.token || req.body?.token || req.get("x-admin-token");
  if (t === ADMIN_TOKEN) return next();
  return res.status(401).send("Unauthorized");
}

// -------- health ----------
app.get("/health", (_, res) => res.send("ok"));

// -------- miniWeb adición y borrado de números Whatsapp ------

app.get("/recipients", requireAdmin, (req, res) => {
  const list = getRecipients();
  const tokenQS = ADMIN_TOKEN ? `?token=${encodeURIComponent(ADMIN_TOKEN)}` : "";
  const fixed = new Set(ALWAYS_ON);
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<title>Destinatarios WhatsApp</title><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{font-family:system-ui,Segoe UI,Arial;max-width:720px;margin:24px auto;padding:0 16px}
  .chip{display:flex;justify-content:space-between;align-items:center;border:1px solid #ddd;border-radius:10px;padding:8px 12px;margin:6px 0}
  button{padding:8px 12px;border:0;background:#111;color:#fff;border-radius:8px;cursor:pointer}
  button.danger{background:#b00020}
  input[type=text]{flex:1;padding:8px 10px;border:1px solid #ccc;border-radius:8px}
  form{display:flex;gap:8px;margin:12px 0}
  .hint{font-size:12px;opacity:.8}
</style></head><body>
  <h1>Destinatarios de WhatsApp</h1>
  <p class="hint">Acepta: <code>whatsapp:+57...</code>, <code>+57...</code> o celular de 10 dígitos (asume +57).</p>

  <h2>Actuales</h2>
  ${list.map(n => `
    <div class="chip">
      <div><strong>${n}</strong> ${fixed.has(n) ? '<small>(fijo)</small>' : ''}</div>
      ${fixed.has(n) ? '' : `
        <form method="POST" action="/recipients/remove${tokenQS}">
          ${ADMIN_TOKEN ? `<input type="hidden" name="token" value="${ADMIN_TOKEN}">` : ""}
          <input type="hidden" name="to" value="${n}">
          <button class="danger" type="submit">Quitar</button>
        </form>
      `}
    </div>
  `).join("") || "<p>(vacío)</p>"}

  <h2>Agregar</h2>
  <form method="POST" action="/recipients/add${tokenQS}">
    ${ADMIN_TOKEN ? `<input type="hidden" name="token" value="${ADMIN_TOKEN}">` : ""}
    <input name="to" type="text" placeholder="whatsapp:+57..., +57..., 313..." required>
    <button type="submit">Agregar</button>
  </form>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

app.post("/recipients/add", requireAdmin, (req, res) => {
  const raw = req.body?.to || "";
  const norm = normalizeWhatsApp(raw);
  if (!norm) return res.status(400).send("Número no válido");
  recipients.add(norm);
  log("Recipient ADD:", norm);
  const back = ADMIN_TOKEN ? `/recipients?token=${encodeURIComponent(ADMIN_TOKEN)}` : "/recipients";
  res.redirect(back);
});

app.post("/recipients/remove", requireAdmin, (req, res) => {
  const raw = String(req.body?.to || "");
  const to = raw.startsWith("whatsapp:") ? raw : normalizeWhatsApp(raw);
  if (!to) return res.status(400).send("Número no válido");
  if (ALWAYS_ON.has(to)) return res.status(400).send("No se puede quitar el número fijo");
  if (!recipients.has(to)) return res.status(404).send("Número no está en la lista");
  recipients.delete(to);
  log("Recipient DEL:", to);
  const back = ADMIN_TOKEN ? `/recipients?token=${encodeURIComponent(ADMIN_TOKEN)}` : "/recipients";
  res.redirect(back);
});

// -------- prueba Twilio ----------
app.post("/test/whatsapp", async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(500).json({ ok:false, error: "Twilio no está configurado (TWILIO_SID/TWILIO_TOKEN)" });
    }
    const to = (req.body?.to || getRecipients()[0] || "").trim();
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
    const list = getRecipients();
    if (!twilioClient || !waFrom || list.length === 0) {
      log("No se envía WhatsApp: falta TWILIO_SID/TWILIO_TOKEN/WHATSAPP_FROM o lista vacía");
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
    for (const to of list) {
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