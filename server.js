// server.js
const express = require("express");
const bodyParser = require("body-parser");

// --- Twilio ---
const twilioSid   = process.env.TWILIO_SID;
const twilioToken = process.env.TWILIO_TOKEN;
const waFrom      = process.env.WHATSAPP_FROM;

// --- Destinatarios dinámicos (en memoria) ---
const ALWAYS_ON = new Set(["whatsapp:+573134991467"]); // fijo por código
const waToInit = (process.env.WHATSAPP_TO || "").split(",").map(s => s.trim()).filter(Boolean);
const recipients = new Set([...waToInit, ...ALWAYS_ON]);

function getRecipients() {
  return Array.from(new Set([...ALWAYS_ON, ...recipients]));
}

// Secreto opcional para el webhook y miniWeb
const hookSecret  = process.env.WEBHOOK_SECRET || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Banner y pie de pagina miniWeb
const BRAND = {
  product: "DukeVilla Demito",
  company: "DukeVilla LLC",
  year: 2026,
  url: "https://www.duke-villa.com - www.fibersas.com",
  email: "sales@duke-villa.com - carlos@fibersas.com - +57 3134991444",
  logoPath: "/static/dukevilla-logo.jpg", 
};

// Firma corta para WhatsApp (líneas al final)
const BRAND_SIGNATURE = [
  `— ${BRAND.product}`,
  `Desarrollado por ${BRAND.company} — ${BRAND.year}`,
  `${BRAND.url} | ${BRAND.email}`,
].join("\n");


// --- Mapa de casas (DevEUI en minúsculas) ---
const HOUSE_MAP = {
  // 🔴 BOTONES PÁNICO (LBM01)
  "ffffff100004f737": "Botón Pánico Casa Cuadrado",
  "ffffff100004f73f": "Botón Pánico Casa Estrella",
  "ffffff100004f749": "Botón Pánico Casa Triángulo",
  
  // 🚪 PUERTAS (LSD01)
  "ffffff1000053192": "Puerta Rack Cuadrado",
  "ffffff10000531a2": "Puerta Rack Estrella",
  "ffffff1000053199": "Puerta Rack Triángulo",

  // 🌡️ TEMPERATURA (LST01)
  "ffffff10000507dc": "Temperatura Sala Equipos Cuadrado",
  "ffffff1000051827": "Temperatura Sala Equipos Estrella",
  "ffffff100005181a": "Temperatura Sala Equipos Triángulo",

  // 📍 RASTREO (LTB01-G)
  "ffffff100004f568": "Rastreo GPS Equipo Cuadrado",
  "ffffff100004cb45": "Rastreo GPS Equipo Triángulo",
};

// --- Estado de sensores (on/off + coordenadas) ---
const SENSOR_CONFIG = {
  "ffffff100004f737": { enabled: false, lat: 4.718681, lng: -74.037496 },
  "ffffff100004f73f": { enabled: false, lat: 4.718681, lng: -74.037496 },
  "ffffff100004f749": { enabled: false, lat: 4.718681, lng: -74.037496 },

  "ffffff1000053192": { enabled: false, lat: 4.718681, lng: -74.037496 },
  "ffffff10000531a2": { enabled: false, lat: 4.718681, lng: -74.037496 },
  "ffffff1000053199": { enabled: false, lat: 4.718681, lng: -74.037496 },

  "ffffff10000507dc": { enabled: false, lat: 4.718681, lng: -74.037496, threshold: 45 },
  "ffffff1000051827": { enabled: false, lat: 4.718681, lng: -74.037496, threshold: 45 },
  "ffffff100005181a": { enabled: false, lat: 4.718681, lng: -74.037496, threshold: 45 },

  "ffffff100004f568": { enabled: false, lat: 4.718681, lng: -74.037496 },
  "ffffff100004cb45": { enabled: false, lat: 4.718681, lng: -74.037496 },
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
function formatHuman({ event, house, devName, devEui, fCnt, battery_mv, location, obj }) {
  let title, tipo;
  if (event === "panic")       { title = "🚨 *Alerta de Pánico*";        tipo = "Botón de Pánico"; }
  else if (event === "wall_remove") { title = "⚠️ *Alerta: Desmonte de Pared*"; tipo = "Desmonte de Pared"; }
  else if (event === "wall_restore"){ title = "✅ *Restaurado en la Pared*";     tipo = "Restaurado"; }
  else if (event === "low_battery"){ title = "🔋 *Batería baja*";              tipo = "Batería baja"; }
  else if (event === "door_open") { title = "🚪 *Puerta Abierta*";        tipo = "Apertura"; }
  else if (event === "door_close") { title = "🚪 *Puerta Cerrada*";        tipo = "Cierre"; }
  else if (event === "temperature") { title = "🌡️ *Temperatura / Humedad*";        tipo = "Ambiental"; }
  else if (event === "gps") { title = "📍 *Ubicación GPS*";        tipo = "Rastreo"; }
  else if (event === "high_temperature") { title = "🔥 *ALERTA: Temperatura Alta*";       tipo = "Temperatura crítica"; }
  else                            { title = "ℹ️ Evento";                       tipo = event || "N/A"; }

  const mapLine = (location && typeof location.latitude === "number" && typeof location.longitude === "number")
    ? `Ubicación aprox.: https://maps.google.com/?q=${location.latitude},${location.longitude}`
    : null;
  
  const extra = [];

  if (obj?.temperature != null) extra.push(`Temperatura: ${obj.temperature} °C`);
  if (obj?.humidity != null) extra.push(`Humedad: ${obj.humidity} %`);
  if (obj?.latitude != null && obj?.longitude != null) {
    extra.push(`GPS: ${obj.latitude}, ${obj.longitude}`);
  }
  
  const lines = [
    title,
    `Lugar: *${house}*`,
    `Tipo: ${tipo}`,
    `Dispositivo: *${devName}* (${devEui})`,
    ...extra,
    (typeof fCnt === "number") ? `Frame: ${fCnt}` : null,
    (typeof battery_mv === "number") ? `Batería: ${(battery_mv/1000).toFixed(2)} V` : null,
    mapLine,
    `Hora: ${nowBogota()} (Bogotá)`,
    "",           // separador visual
    BRAND_SIGNATURE,  // ← firma DUKEVILLA
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
app.use("/static", express.static("public", { maxAge: "1d", etag: true }));

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
<title>Destinatarios WhatsApp — ${BRAND.product}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  :root { --gold:#b89b58; --ink:#111; }
  body{font-family:system-ui,Segoe UI,Arial;max-width:820px;margin:24px auto;padding:0 16px}
  header.brand{display:flex;align-items:center;gap:12px;margin-bottom:12px}
  header.brand img{height:44px;border-radius:6px}
  header.brand .title{font-weight:700;font-size:18px}
  header.brand .tag{font-size:12px;opacity:.8}
  h1{font-size:20px;margin:12px 0}
  .chip{display:flex;justify-content:space-between;align-items:center;border:1px solid #ddd;border-radius:10px;padding:8px 12px;margin:6px 0}
  button{padding:8px 12px;border:0;background:var(--ink);color:#fff;border-radius:8px;cursor:pointer}
  button.danger{background:#b00020}
  input[type=text]{flex:1;padding:8px 10px;border:1px solid #ccc;border-radius:8px}
  form{display:flex;gap:8px;margin:12px 0}
  .hint{font-size:12px;opacity:.8}
  footer{margin-top:28px;padding-top:12px;border-top:1px dashed #ddd;font-size:12px;opacity:.8}
  a{color:var(--ink);text-decoration:none;border-bottom:1px solid rgba(0,0,0,.2)}
</style></head><body>

<header class="brand">
  <img src="${BRAND.logoPath}" alt="Logo DukeVilla">
  <div>
    <div class="title">${BRAND.product}</div>
    <div class="tag">Data Transmission & Signal Processing</div>
  </div>
</header>

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

<h2>Activar Sensores</h2>

<form method="POST" action="/sensors/update${tokenQS}" style="display:block;width:100%;">
  ${ADMIN_TOKEN ? `<input type="hidden" name="token" value="${ADMIN_TOKEN}">` : ""}

  ${Object.entries(HOUSE_MAP).map(([dev, name]) => {
    const cfg = SENSOR_CONFIG[dev] || {};
    const nameLower = name.toLowerCase();
    const isTemp = nameLower.includes("temperatura");
    const isGPS  = nameLower.includes("gps");
    return `
      <div style="display:flex;align-items:center;gap:12px;margin:8px 0;padding-bottom:6px;border-bottom:1px dashed #ddd;">
    
        <input type="checkbox" name="enabled_${dev}" ${cfg.enabled ? "checked" : ""}>
    
        <label style="min-width:300px;font-weight:600">
          ${name}
        </label>

        ${!isGPS ? `
          <span style="font-size:12px;opacity:0.7;margin-left:10px">
            Coordenadas:
          </span>
          <input name="lat_${dev}" value="${cfg.lat || ""}" style="width:90px;text-align:center">
          <input name="lng_${dev}" value="${cfg.lng || ""}" style="width:90px;text-align:center">
        ` : ``}

        ${isTemp ? `
          <span style="font-size:12px;opacity:0.7;margin-left:10px">
            Umbral (°C):
          </span>
          <input name="threshold_${dev}" value="${cfg.threshold ?? 45}" style="width:70px;text-align:center">
        ` : ``}
      </div>
    `;
  }).join("")}

  <button type="submit">Actualizar configuración sensor</button>
</form>

<footer>
  <div>Desarrollado por ${BRAND.company} — ${BRAND.year}</div>
  <div><a href="${BRAND.url}" target="_blank" rel="noopener">${BRAND.url}</a> •
      <a href="mailto:${BRAND.email}">${BRAND.email}</a></div>
</footer>

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

app.post("/sensors/update", requireAdmin, (req, res) => {
  Object.keys(HOUSE_MAP).forEach(dev => {
    const enabled = req.body[`enabled_${dev}`] === "on";
    const lat = parseFloat(req.body[`lat_${dev}`]);
    const lng = parseFloat(req.body[`lng_${dev}`]);
    const threshold = parseFloat(req.body[`threshold_${dev}`]);

    const prev = SENSOR_CONFIG[dev] || {};

    SENSOR_CONFIG[dev] = {
      enabled,
      lat: isNaN(lat) ? prev.lat : lat,
      lng: isNaN(lng) ? prev.lng : lng,
      threshold: isNaN(threshold) ? (prev.threshold ?? 45) : threshold,
    };
  });

  log("SENSOR CONFIG UPDATED", SENSOR_CONFIG);

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
    const msgBody = req.body?.body || "Mensaje de prueba ✅";

    if (!to || !to.startsWith("whatsapp:")) {
      return res.status(400).json({ ok:false, error: "Falta 'to' (formato whatsapp:+57...)" });
    }
    if (!waFrom) {
      return res.status(400).json({ ok:false, error: "Falta WHATSAPP_FROM" });
    }

    const msg = await twilioClient.messages.create({ from: waFrom, to, body: msgBody });
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

    let finalEvent = eventKey;

    // --- FILTRO POR SENSOR ACTIVADO ---
    const devKey = String(devEui || "").toLowerCase();
    const cfg = SENSOR_CONFIG[devKey];

    if (eventKey === "temperature" && obj?.temperature != null) {
      const threshold = cfg?.threshold ?? 45;

      if (obj.temperature >= threshold) {
        finalEvent = "high_temperature";
        log(`🔥 Temp alta: ${obj.temperature} >= ${threshold}`);
      }
    }

    if (!cfg || !cfg.enabled) {
      log("Sensor no configurado o desactivado → no se envía", devKey);
      return res.json({ ok:true, skipped: "disabled" });
    }

    // 2) Anti-duplicados SOLO para pánico
    if (eventKey === "panic" && !allowPanic(devEui, fCnt)) {
      log("Pánico duplicado (TTL) -> omitido", devEui, fCnt);
      return res.json({ ok:true, skipped: "panic dedup" });
    }

    log(`Uplink (${event}) dev=${devName}/${devEui} fCnt=${fCnt} event=${finalEvent} obj=`, obj);

    // 3) Política de notificación
    // Enviar WhatsApp para TODOS los eventos útiles
    // No enviar: alive, low_battery
    if (!finalEvent || finalEvent === "alive" || finalEvent === "low_battery") {
      return res.json({ ok:true, skipped: finalEvent || "no_event" });
    }

    // Verificación Twilio
    const list = getRecipients();
    if (!twilioClient || !waFrom || list.length === 0) {
      log("No se envía WhatsApp: falta TWILIO_SID/TWILIO_TOKEN/WHATSAPP_FROM o lista vacía");
      return res.json({ ok:true, warn:"twilio not configured" });
    }
    
    // elegir gateway con mejor SNR (o el primero)
    const rx = Array.isArray(body?.rxInfo) ? body.rxInfo : [];
    const best = rx.slice().sort((a,b) => (b?.snr ?? -Infinity) - (a?.snr ?? -Infinity))[0] || rx[0];
    const sensorName = HOUSE_MAP[devKey] || "";
    const isGpsDevice = sensorName.toLowerCase().includes("gps");

    let location = null;

    // 1. Si el sensor trae GPS real → usarlo
    if (obj?.latitude != null && obj?.longitude != null) {
      location = { latitude: obj.latitude, longitude: obj.longitude };

    // 2. Si NO trae GPS → usar configuración manual (TU WEB)
    } else if (cfg?.lat != null && cfg?.lng != null) {
      location = { latitude: cfg.lat, longitude: cfg.lng };

    // 3. Fallback final → gateway
    } else if (!isGpsDevice && best?.location) {
    location = best.location;
    }

    // Texto humano (incluye casa por DevEUI y batería si vino del codec)
    const text = formatHuman({
      event: finalEvent,
      house: houseName(devEui, devName),
      devName,
      devEui,
      fCnt,
      battery_mv: obj?.battery_mv,
      location,
      obj
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