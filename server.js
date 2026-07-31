// server.js
const express = require("express");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const crypto = require("crypto");

// --- Twilio ---
const twilioSid   = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
const twilioToken = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN;
const waFromRaw   = process.env.WHATSAPP_FROM || "";
const waFrom      = waFromRaw && waFromRaw.startsWith("whatsapp:") ? waFromRaw : (waFromRaw ? `whatsapp:${waFromRaw}` : "");
const twilioContentSid = process.env.TWILIO_CONTENT_SID || "";

// --- Destinatarios separados por rol ---
const ALWAYS_ON = new Set(["whatsapp:+573134991467"]); // fijo por código
const recipientsByRole = {
  admin: new Set((process.env.WHATSAPP_TO_ADMIN || process.env.WHATSAPP_TO || "").split(",").map(s => s.trim()).filter(Boolean)),
  guest: new Set((process.env.WHATSAPP_TO_GUEST || "").split(",").map(s => s.trim()).filter(Boolean)),
};

function getRecipients(role) {
  const scoped = recipientsByRole[role] || new Set();
  return Array.from(new Set([...ALWAYS_ON, ...scoped]));
}

// Secreto opcional para el webhook. La miniWeb usa login + cookie de sesión.
const hookSecret  = process.env.WEBHOOK_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "demito-2026-change-in-production";
const USERS = Object.freeze({
  invitado: { password: "Duk3vi114", role: "guest" },
  admin: { password: "T@b0g02026", role: "admin" },
});
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Banner y pie de pagina miniWeb
const BRAND = {
  product: "DukeVilla Demito",
  company: "DukeVilla LLC",
  year: 2026,
  url: "https://www.duke-villa.com - www.fibersas.com",
  email: "sales@duke-villa.com - carlos@fibersas.com - +57 3134991444",
  logoPath: "/static/dukevilla-logo.jpg", 
};

const FACIL_STYLES = `
  :root{--background:#f5f5f7;--surface:#fff;--surface-secondary:#fafafa;--text:#111827;--text-light:#6b7280;--border:rgba(0,0,0,.08);--accent:#ff3b1d;--accent-dark:#e42d10;--primary:#2563eb;--success:#34c759;--danger:#ff3b30;--shadow:0 10px 30px rgba(0,0,0,.06);--radius:18px}
  *{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}a{color:inherit}button,input,select{font:inherit}button{border:0;cursor:pointer;transition:.25s ease}.page{width:min(1400px,calc(100% - 32px));margin:24px auto 50px}.topbar{position:sticky;top:12px;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 18px;background:rgba(255,255,255,.9);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.6);border-radius:22px;box-shadow:var(--shadow)}.brand{display:flex;align-items:center;gap:14px}.brand img{width:116px;height:56px;object-fit:contain}.brand-title{font-size:20px;font-weight:800}.brand-tag,.hint{color:var(--text-light);font-size:13px}.userbox{display:flex;align-items:center;gap:10px}.role-pill,.owner-badge{display:inline-flex;padding:6px 10px;border-radius:999px;background:#eaf2ff;color:var(--primary);font-size:12px;font-weight:700}.hero{padding:38px 4px 20px}.hero h1{margin:0 0 8px;font-size:clamp(30px,5vw,46px);line-height:1.05}.hero p{margin:0;color:var(--text-light);font-size:17px}.grid{display:grid;grid-template-columns:minmax(280px,.72fr) minmax(0,2fr);gap:22px;align-items:start}.card{background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:22px;box-shadow:var(--shadow);margin-bottom:22px}.card h2{margin:0 0 8px;font-size:20px}.card h3{margin:20px 0 8px}.chip{display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid var(--border);background:var(--surface-secondary);border-radius:14px;padding:10px 12px;margin:8px 0}.row-form{display:flex;gap:8px;margin:12px 0}.field,input:not([type=checkbox]),select{width:100%;min-height:44px;padding:9px 12px;border:1px solid var(--border);background:#fff;border-radius:12px;outline:none;transition:.25s ease}input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(255,59,29,.08)}input:disabled{background:#eef0f3;color:#8b95a5}.btn{padding:11px 16px;border-radius:12px;background:var(--accent);color:#fff;font-weight:700}.btn:hover{background:var(--accent-dark);transform:translateY(-1px)}.btn-secondary{background:#111827}.btn-danger{background:var(--danger)}.sensor{display:grid;grid-template-columns:28px minmax(190px,1.2fr) minmax(180px,1fr) auto;gap:10px;align-items:center;padding:14px 0;border-bottom:1px solid var(--border)}.sensor:last-child{border-bottom:0}.sensor-meta{grid-column:2/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.coords{display:flex;gap:8px;align-items:center}.coords input{width:110px!important}.savebar{display:flex;justify-content:flex-end;padding-top:18px}footer{padding:20px 4px;color:var(--text-light);font-size:12px}.login-page{min-height:100vh;display:grid;place-items:center;padding:28px;background:radial-gradient(circle at 15% 10%,rgba(255,59,29,.12),transparent 34%),var(--background)}.login-card{width:min(480px,100%);background:rgba(255,255,255,.88);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.5);border-radius:36px;padding:48px;box-shadow:0 30px 80px rgba(0,0,0,.08)}.login-logo{width:230px;height:110px;object-fit:contain;margin:0 auto 24px;display:block}.login-card h1{text-align:center;font-size:42px;margin:0 0 12px}.login-card p{text-align:center;color:var(--text-light);line-height:1.6}.login-form{display:flex;flex-direction:column;gap:14px;margin-top:28px}.login-form input{height:60px;border-radius:18px;padding:0 20px}.login-form .btn{height:60px;border-radius:18px}.login-footer{text-align:center;margin-top:26px;color:var(--text-light);font-size:13px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}.sensor{grid-template-columns:28px 1fr}.sensor>*:not(input[type=checkbox]){grid-column:2}.sensor-meta{grid-column:2}.topbar{position:static}.brand-tag{display:none}}
  @media(max-width:560px){.page{width:min(100% - 20px,1400px);margin-top:10px}.topbar{align-items:flex-start}.brand img{width:78px}.userbox{flex-direction:column;align-items:flex-end}.card{padding:17px;border-radius:18px}.row-form{flex-direction:column}.login-card{padding:30px 22px;border-radius:26px}.login-card h1{font-size:34px}}
`;

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

const GUEST_SENSOR_IDS = new Set([
  "ffffff100004f737", "ffffff100004f73f", "ffffff100004f749",
  "ffffff1000053192", "ffffff10000531a2", "ffffff1000053199",
  "ffffff10000507dc", "ffffff1000051827", "ffffff100005181a",
]);

// --- Estado de sensores (on/off + coordenadas) ---
const SENSOR_CONFIG = {
  "ffffff100004f737": { enabled: false, lat: 4.718681, lng: -74.037496, location: "" },
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
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
function formatHuman({ event, house, locationName, location, obj }) {
  const temperature = obj?.temperature != null ? `${obj.temperature} °C` : "temperatura";
  const humidity = obj?.humidity != null ? ` y humedad ${obj.humidity} %` : "";
  const actions = {
    panic: "reporta botón de pánico activado",
    wall_remove: "reporta desmonte de pared",
    wall_restore: "reporta restauración en la pared",
    door_open: "reporta puerta abierta",
    door_close: "reporta puerta cerrada",
    temperature: `reporta ${temperature}${humidity}`,
    high_temperature: `reporta temperatura alta: ${temperature}${humidity}`,
    gps: "reporta nueva ubicación",
  };
  const mapLine = (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude))
    ? `https://maps.google.com/?q=${location.latitude},${location.longitude}` : null;
  const lines = [
    `${house} ${actions[event] || `reporta ${event || "un evento"}`}`,
    nowBogota(),
    locationName || "Ubicación no configurada",
    mapLine,
    "",
    "www.fibersas.com - www.duke-villa.com - 2026",
  ];
  return lines.filter(Boolean).join("\n");
}

function twilioMessageOptions(to, body) {
  const base = { from: waFrom, to };
  if (!twilioContentSid) return { ...base, body };
  const lines = body.split("\n").filter(Boolean);
  return {
    ...base,
    contentSid: twilioContentSid,
    contentVariables: JSON.stringify({
      "1": lines[0] || "Demito reporta un evento",
      "2": lines[1] || nowBogota(),
      "3": lines[2] || "Ubicación no configurada",
      "4": lines[3] || "Mapa no disponible",
    }),
  };
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

/*
=========================================
BLE DEVICES
=========================================
*/

const BLE_DEVICES = {
  "c30000585b9f": "Baño Cuadrado",
  "c30000585b66": "Baño Triángulo",
  "c30000585ba2": "Baño Estrella",
  "c300004d2d4c": "Manilla B7"
};

const BLE_CONFIG = {
  "c30000585b9f": {
    enabled: false,
    lat: 4.718681,
    lng: -74.037496
  },

  "c30000585b66": {
    enabled: false,
    lat: 4.718681,
    lng: -74.037496
  },

  "c30000585ba2": {
    enabled: false,
    lat: 4.718681,
    lng: -74.037496
  }
};

/*
=========================================
POSTGRES
=========================================
*/

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use("/static", express.static("public", { maxAge: "1d", etag: true }));

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf("=");
    return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}

function signSession(username, role, expires) {
  const payload = Buffer.from(JSON.stringify({ username, role, expires })).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readSession(req) {
  const token = parseCookies(req).demito_session;
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return session.expires > Date.now() ? session : null;
  } catch { return null; }
}

function requireUser(req, res, next) {
  req.user = readSession(req);
  if (req.user) return next();
  if (req.path.startsWith("/api/") || req.method !== "GET") return res.status(401).json({ ok:false, error:"unauthorized" });
  return res.redirect("/login");
}

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
  req.user = readSession(req);
  if (req.user?.role === "admin") return next();
  return res.status(req.user ? 403 : 401).send("No autorizado");
}

app.get("/", (req, res) => res.redirect(readSession(req) ? "/recipients" : "/login"));
app.get("/login", (req, res) => res.type("html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demito — Ingreso</title><link rel="icon" href="/static/favicon.ico" type="image/x-icon"><style>${FACIL_STYLES}</style></head><body><main class="login-page"><section class="login-card"><img src="/static/logo-facil-iot.png" alt="Facil IoT" class="login-logo"><h1>Demito</h1><p>Monitoreo sencillo de sensores LoRaWAN y BLE, con la experiencia visual de Facil IoT.</p><form class="login-form" method="post" action="/login"><input name="username" autocomplete="username" placeholder="Usuario" required><input name="password" type="password" autocomplete="current-password" placeholder="Contraseña" required><button class="btn" type="submit">Ingresar</button></form><div class="login-footer">Powered by DukeVilla · Facil IoT</div></section></main></body></html>`));
app.post("/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const account = USERS[username];
  const supplied = Buffer.from(String(req.body?.password || ""));
  const expected = Buffer.from(account?.password || "invalid-password");
  if (!account || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).send("Usuario o contraseña incorrectos. <a href=\"/login\">Volver</a>");
  const token = signSession(username, account.role, Date.now() + SESSION_TTL_MS);
  res.setHeader("Set-Cookie", `demito_session=${token}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  res.redirect("/recipients");
});
app.post("/logout", (req, res) => { res.setHeader("Set-Cookie", "demito_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"); res.redirect("/login"); });

// -------- health ----------
app.get("/health", (_, res) => res.send("ok"));

app.get("/api/ble/latest", requireAdmin, async (req, res) => {

  try {

    const result = await db.query(`
      SELECT DISTINCT ON (sensor_id)
        sensor_id,
        event_type,
        payload,
        ts
      FROM sensor_history
      WHERE source='BLE'
      AND event_type='ble_occ'
      ORDER BY sensor_id, ts DESC
    `);

    res.json(result.rows);

  } catch(err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }

});

app.get("/api/ble/history", requireAdmin, async (req, res) => {
  
  const range =
    req.query.range || "day";

  let interval = "24 hours";

  if (range === "week")
    interval = "7 days";

  if (range === "month")
    interval = "30 days";

  try {

    const result = await db.query(`
      SELECT
        ts,
        sensor_id,
        payload
      FROM sensor_history
      WHERE event_type='ble_occ'
        AND ts >= NOW() - INTERVAL '${interval}'
      ORDER BY ts ASC
    `);

    res.json(result.rows);

  } catch(err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }

});

// -------- miniWeb adición y borrado de números Whatsapp ------

app.get("/recipients", requireUser, (req, res) => {
  const isAdmin = req.user.role === "admin";
  const currentRole = req.user.role;
  const list = getRecipients(req.user.role);
  const tokenQS = "";
  const fixed = new Set(ALWAYS_ON);
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<title>Destinatarios WhatsApp — ${BRAND.product}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="/static/favicon.ico" type="image/x-icon"/>
<style>${FACIL_STYLES}</style></head><body><div class="page">

<header class="topbar">
  <div class="brand">
    <img src="/static/logo-facil-iot.png" alt="Facil IoT">
    <div>
      <div class="brand-title">Demito</div>
      <div class="brand-tag">Sensores conectados por Facil IoT</div>
    </div>
  </div>
  <div class="userbox"><span class="role-pill">${isAdmin ? "Administrador" : "Invitado"}</span><form method="POST" action="/logout"><button class="btn btn-secondary" type="submit">Salir</button></form></div>
</header>

<section class="hero"><h1>Panel Demito</h1><p>Configura alertas y sensores para <b>${req.user.username}</b>.</p></section>
<div class="grid"><aside class="card">
<h2>Destinatarios WhatsApp</h2>
<p class="hint">Acepta: <code>whatsapp:+57...</code>, <code>+57...</code> o celular de 10 dígitos (asume +57).</p>

<h2>Actuales</h2>
${list.map(n => `
  <div class="chip">
    <div><strong>${n}</strong> ${fixed.has(n) ? '<small>(fijo)</small>' : ''}</div>
    ${fixed.has(n) ? '' : `
      <form method="POST" action="/recipients/remove${tokenQS}">
        <input type="hidden" name="to" value="${n}">
        <button class="btn btn-danger" type="submit">Quitar</button>
      </form>
    `}
  </div>
`).join("") || "<p>(vacío)</p>"}

<h2>Agregar</h2>
<form class="row-form" method="POST" action="/recipients/add${tokenQS}">
  <input name="to" type="text" placeholder="whatsapp:+57..., +57..., 313..." required>
  <button class="btn" type="submit">Agregar</button>
</form>
<p class="hint">Esta lista pertenece únicamente a <b>${req.user.username}</b>. El número fijo de soporte se incluye siempre.</p>
</aside><main class="card">

<h2>Sensores</h2><p class="hint">Activa un sensor para asignarlo a este usuario. Los sensores en uso por el otro rol aparecen bloqueados.</p>

<form method="POST" action="/sensors/update${tokenQS}" style="display:block;width:100%;">
  ${Object.entries(HOUSE_MAP).filter(([dev]) => isAdmin || GUEST_SENSOR_IDS.has(dev)).map(([dev, name]) => {
    const cfg = SENSOR_CONFIG[dev] || {};
    const locked = cfg.ownerRole && cfg.ownerRole !== currentRole;
    const nameLower = name.toLowerCase();
    const isTemp = nameLower.includes("temperatura");
    const isGPS  = nameLower.includes("gps");
    return `
      <div class="sensor">
    
        <input type="checkbox" name="enabled_${dev}" ${cfg.enabled ? "checked" : ""} ${locked ? "disabled" : ""}>
    
        <input name="name_${dev}" value="${escapeHtml(name)}" aria-label="Nombre del sensor" style="min-width:260px;font-weight:600" ${locked ? "disabled" : ""}>

        <input name="location_${dev}" value="${escapeHtml(cfg.location || "")}" placeholder="Ubicación (ej. Bodega norte)" style="min-width:210px" ${locked ? "disabled" : ""}>
        ${locked ? `<span class="owner-badge">En uso por ${cfg.ownerRole === "admin" ? "admin" : "invitado"}</span>` : ""}

        <div class="sensor-meta">
        ${!isGPS ? `<div class="coords"><span class="hint">Coordenadas:</span>
          <input name="lat_${dev}" value="${cfg.lat || ""}" style="width:90px;text-align:center" ${locked ? "disabled" : ""}>
          <input name="lng_${dev}" value="${cfg.lng || ""}" style="width:90px;text-align:center" ${locked ? "disabled" : ""}>
        </div>` : ``}

        ${isTemp ? `
          <span class="hint">Umbral (°C):</span>
          <input name="threshold_${dev}" value="${cfg.threshold ?? 45}" style="width:70px;text-align:center" ${locked ? "disabled" : ""}>
        ` : ``}
        </div>
      </div>
    `;
  }).join("")}

  <div class="savebar"><button class="btn" type="submit">Guardar configuración</button></div>
</form>
</main></div>

${isAdmin ? `<section class="card"><h2>Sensores BLE</h2>

<div id="bleConfig"></div>

<h2>DASHBOARD BLE</h2>

<div style="margin-bottom:10px">
  Periodo:
  <select id="blePeriod">
    <option value="day">Día</option>
    <option value="week">Semana</option>
    <option value="month">Mes</option>
  </select>
</div>

<div style="
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:16px;
  margin-bottom:16px;
">

  <div style="
    border:1px solid #ddd;
    border-radius:8px;
    padding:10px;
  ">
    <b>Ocupaciones por Hora</b>
    <canvas id="bleChartOcc"></canvas>
  </div>

  <div style="
    border:1px solid #ddd;
    border-radius:8px;
    padding:10px;
  ">
    <b>Nivel de Utilización (%)</b>
    <canvas id="bleChartTime"></canvas>
  </div>

</div>

<button id="bleReportBtn">
  Generar Reporte WhatsApp
</button>

<br><br>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<script>

fetch("/api/ble/latest")
  .then(r => r.json())
  .then(data => {

    console.log(
      "BLE DATA",
      data
    );

    let bleHtml = "";

    data.forEach(sensor => {

      const name =
        sensor.payload &&
        sensor.payload.sensor_name
          ? sensor.payload.sensor_name
          : sensor.sensor_id;

      bleHtml +=
        '<div style="border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:8px;background:#fafafa;">' +
        '<b>' + name + '</b>' +
        '<div style="margin-top:8px">' +
        '<label><input type="checkbox" checked> Dashboard</label><br>' +
        '<label><input type="checkbox" checked> Reporte WhatsApp</label>' +
        '</div>' +
        '</div>';

    });

    document.getElementById("bleConfig")
      .innerHTML = bleHtml;

  });

fetch(
  "/api/ble/history?range=" +
  (
    document.getElementById("blePeriod")?.value ||
    "day"
  )
)
.then(r => r.json())
.then(rows => {

  const visitsPerHour = {
    "c30000585b9f": {},
    "c30000585b66": {},
    "c30000585ba2": {}
  };
  const occupancyDurations = {
    "c30000585b9f": {},
    "c30000585b66": {},
    "c30000585ba2": {}
  };;

  const sensors = {};

  rows.forEach(r => {

    if (!r.payload?.telemetry) return;

    const sid = r.sensor_id;
    const tel = r.payload.telemetry;

    if (!sensors[sid]) {
      sensors[sid] = {
        lastCount: null,
        lastOccupied: null,
        occupiedSince: null
      };
    }

    const s = sensors[sid];
    
    const period =
      document.getElementById("blePeriod")?.value ||
      "day";

    const ts = new Date(r.ts);

    let bucket;

    if (period === "day") {

      bucket =
        ts.getHours()
          .toString()
          .padStart(2,"0");

    }
    else if (period === "week") {

      bucket =
        ["Dom","Lun","Mar","Mie","Jue","Vie","Sab"]
        [ts.getDay()];

    }
    else {

      bucket =
        ts.getDate()
        .toString();

    }

    //
    // VISITAS
    //

    if (typeof tel.occupy_count === "number") {

      if (s.lastCount !== null) {

        let delta =
          tel.occupy_count -
          s.lastCount;

        if (delta < 0)
          delta += 256;

        if (delta > 0) {

          visitsPerHour[sid][bucket] =
            (visitsPerHour[sid][bucket] || 0)
            + delta;

        }

      }

      s.lastCount =
        tel.occupy_count;
    }

    //
    // TIEMPO DE OCUPACION
    //

    if (
      s.lastOccupied === false &&
      tel.occupied === true
    ) {

      s.occupiedSince = ts;

    }

    if (
      s.lastOccupied === true &&
      tel.occupied === false &&
      s.occupiedSince
    ) {

      const mins =
        (ts - s.occupiedSince)
        / 60000;

      if (!occupancyDurations[sid][bucket]) {
        occupancyDurations[sid][bucket] = [];
      }

      occupancyDurations[sid][bucket]
        .push(mins);

      s.occupiedSince = null;
    }

    s.lastOccupied =
      tel.occupied;

  });

  const labels = [];

  const visitsCuadrado = [];
  const visitsTriangulo = [];
  const visitsEstrella = [];

  const utilCuadrado = [];
  const utilTriangulo = [];
  const utilEstrella = [];

  const avgCuadrado = [];
  const avgTriangulo = [];
  const avgEstrella = [];

  for (let h=0; h<24; h++) {

    const hh =
      h.toString()
        .padStart(2,"0");

    labels.push(hh);

    visitsCuadrado.push(
      visitsPerHour["c30000585b9f"][hh] || 0
    );

    visitsTriangulo.push(
      visitsPerHour["c30000585b66"][hh] || 0
    );

    visitsEstrella.push(
      visitsPerHour["c30000585ba2"][hh] || 0
    );
    
    utilCuadrado.push(
      Math.min(
        100,
        (visitsPerHour["c30000585b9f"][hh] || 0) * 10
      )
    );

    utilTriangulo.push(
      Math.min(
        100,
        (visitsPerHour["c30000585b66"][hh] || 0) * 10
      )
    );

    utilEstrella.push(
      Math.min(
        100,
        (visitsPerHour["c30000585ba2"][hh] || 0) * 10
      )
    );

    const arrC =
      occupancyDurations["c30000585b9f"][hh] || [];

    const arrT =
      occupancyDurations["c30000585b66"][hh] || [];

    const arrE =
      occupancyDurations["c30000585ba2"][hh] || [];

    avgCuadrado.push(
      arrC.length
        ? Number(
            (
              arrC.reduce((a,b)=>a+b,0)
              / arrC.length
            ).toFixed(1)
          )
        : 0
    );

    avgTriangulo.push(
      arrT.length
        ? Number(
            (
              arrT.reduce((a,b)=>a+b,0)
              / arrT.length
            ).toFixed(1)
          )
        : 0
    );

    avgEstrella.push(
      arrE.length
        ? Number(
            (
              arrE.reduce((a,b)=>a+b,0)
              / arrE.length
            ).toFixed(1)
          )
        : 0
    );

  }
  
  console.log("VISITS CUADRADO", visitsCuadrado);
  console.log("VISITS TRIANGULO", visitsTriangulo);
  console.log("VISITS ESTRELLA", visitsEstrella);

  console.log("UTIL CUADRADO", utilCuadrado);
  console.log("UTIL TRIANGULO", utilTriangulo);
  console.log("UTIL ESTRELLA", utilEstrella);

  new Chart(
    document.getElementById("bleChartOcc"),
    {
      type:"line",
      data:{
        labels,
        datasets:[
          {
            label:"Cuadrado",
            data:visitsCuadrado
          },
          {
            label:"Triángulo",
            data:visitsTriangulo
          },
          {
            label:"Estrella",
            data:visitsEstrella
          }
        ]
      }
    }
  );

  new Chart(
    document.getElementById("bleChartTime"),
    {
      type:"bar",
      data:{
        labels,
        datasets:[
          {
            label:"Cuadrado %",
            data:utilCuadrado
          },
          {
            label:"Triángulo %",
            data:utilTriangulo
          },
          {
            label:"Estrella %",
            data:utilEstrella
          }
        ]
      },
      options:{
        responsive:true,
        scales:{
          y:{
            min:0,
            max:100
          }
        }
      }
    }
  );

});

document
  .getElementById("bleReportBtn")
  .addEventListener(
    "click",
    async () => {

      try {

        const r =
          await fetch(
            "/ble/report",
            {
              method:"POST"
            }
          );

        const j =
          await r.json();

        alert(
          j.ok
            ? "Reporte BLE OK"
            : ("Error: " + j.error)
        );

      } catch(err) {

        alert(err.message);

      }

    }
  );

</script>
</section>` : ""}

<footer>
  <div>Desarrollado por ${BRAND.company} — ${BRAND.year}</div>
  <div><a href="${BRAND.url}" target="_blank" rel="noopener">${BRAND.url}</a> •
      <a href="mailto:${BRAND.email}">${BRAND.email}</a></div>
</footer>

</div></body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

app.post("/recipients/add", requireUser, async (req, res) => {
  const raw = req.body?.to || "";
  const norm = normalizeWhatsApp(raw);
  if (!norm) return res.status(400).send("Número no válido");
  if (!ALWAYS_ON.has(norm)) recipientsByRole[req.user.role].add(norm);
  try {
    if (!ALWAYS_ON.has(norm)) await db.query(`INSERT INTO whatsapp_recipients (role, phone) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.role, norm]);
    log("Recipient ADD:", req.user.role, norm);
    res.redirect("/recipients");
  } catch (err) { res.status(500).send("No se pudo guardar el destinatario"); }
});

app.post("/recipients/remove", requireUser, async (req, res) => {
  const raw = String(req.body?.to || "");
  const to = raw.startsWith("whatsapp:") ? raw : normalizeWhatsApp(raw);
  if (!to) return res.status(400).send("Número no válido");
  if (ALWAYS_ON.has(to)) return res.status(400).send("No se puede quitar el número fijo");
  if (!recipientsByRole[req.user.role].has(to)) return res.status(404).send("Número no está en tu lista");
  recipientsByRole[req.user.role].delete(to);
  try {
    await db.query(`DELETE FROM whatsapp_recipients WHERE role=$1 AND phone=$2`, [req.user.role, to]);
    log("Recipient DEL:", req.user.role, to);
    res.redirect("/recipients");
  } catch (err) { res.status(500).send("No se pudo quitar el destinatario"); }
});

app.post("/sensors/update", requireUser, async (req, res) => {
  const allowedSensors = Object.keys(HOUSE_MAP).filter(dev => req.user.role === "admin" || GUEST_SENSOR_IDS.has(dev));
  allowedSensors.forEach(dev => {
    const existing = SENSOR_CONFIG[dev] || {};
    if (existing.ownerRole && existing.ownerRole !== req.user.role) return;
    const enabled = req.body[`enabled_${dev}`] === "on";
    const lat = parseFloat(req.body[`lat_${dev}`]);
    const lng = parseFloat(req.body[`lng_${dev}`]);
    const threshold = parseFloat(req.body[`threshold_${dev}`]);
    const name = String(req.body[`name_${dev}`] || "").trim().slice(0, 100);
    const location = String(req.body[`location_${dev}`] || "").trim().slice(0, 180);

    const prev = existing;

    if (name) HOUSE_MAP[dev] = name;

    SENSOR_CONFIG[dev] = {
      enabled,
      lat: isNaN(lat) ? prev.lat : lat,
      lng: isNaN(lng) ? prev.lng : lng,
      threshold: isNaN(threshold) ? (prev.threshold ?? 45) : threshold,
      location,
      ownerRole: enabled ? req.user.role : null,
    };
  });

  try {
    await Promise.all(allowedSensors.filter(dev => !SENSOR_CONFIG[dev].ownerRole || SENSOR_CONFIG[dev].ownerRole === req.user.role).map(dev => {
      const cfg = SENSOR_CONFIG[dev];
      return db.query(`
        INSERT INTO sensor_settings (sensor_id, name, enabled, lat, lng, threshold, location, owner_role, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (sensor_id) DO UPDATE SET
          name=EXCLUDED.name, enabled=EXCLUDED.enabled, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
          threshold=EXCLUDED.threshold, location=EXCLUDED.location, owner_role=EXCLUDED.owner_role, updated_at=NOW()
      `, [dev, HOUSE_MAP[dev], cfg.enabled, cfg.lat, cfg.lng, cfg.threshold ?? null, cfg.location || "", cfg.ownerRole]);
    }));
    log("SENSOR CONFIG UPDATED", SENSOR_CONFIG);
    res.redirect("/recipients");
  } catch (err) {
    log("SENSOR CONFIG SAVE ERROR", err.message);
    res.status(500).send("No se pudo guardar la configuración");
  }
});

// -------- prueba Twilio ----------
app.post("/test/whatsapp", requireAdmin, async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(500).json({ ok:false, error: "Twilio no está configurado (TWILIO_SID/TWILIO_TOKEN)" });
    }
    const to = (req.body?.to || getRecipients("admin")[0] || "").trim();
    const msgBody = req.body?.body || "Mensaje de prueba ✅";

    if (!to || !to.startsWith("whatsapp:")) {
      return res.status(400).json({ ok:false, error: "Falta 'to' (formato whatsapp:+57...)" });
    }
    if (!waFrom) {
      return res.status(400).json({ ok:false, error: "Falta WHATSAPP_FROM" });
    }

    const msg = await twilioClient.messages.create(twilioMessageOptions(to, msgBody));
    log("Twilio OK test ->", to, msg.sid);
    res.json({ ok: true, sid: msg.sid });
  } catch (err) {
    log("Twilio ERROR test:", err.message);
    res.status(500).json({ ok:false, error: err.message });
  }
});

// -------- reporte BLE ----------
app.post("/ble/report", requireAdmin, async (req, res) => {

  try {

    console.log("BLE REPORT REQUEST");

    const list = getRecipients("admin");

    if (!twilioClient || !waFrom || list.length === 0) {

      console.log(
        "BLE REPORT: Twilio no configurado o lista vacía"
      );

      return res.json({
        ok: true,
        warn: "twilio not configured"
      });

    }

    const text =
`🚻 DEMITO TEST

Sistema Smart Restroom

Prueba de envío WhatsApp OK`;

    const results = [];

    for (const to of list) {

      try {

        const msg =
          await twilioClient.messages.create(twilioMessageOptions(to, text));

        console.log(
          "BLE TEST SENT ->",
          to,
          msg.sid
        );

        results.push({
          to,
          sid: msg.sid,
          ok: true
        });

      } catch (err) {

        console.error(
          "BLE TEST ERROR ->",
          to,
          err.message
        );

        results.push({
          to,
          ok: false,
          error: err.message
        });

      }

    }

    return res.json({
      ok: true,
      sent: results
    });

  } catch (err) {

    console.error(
      "BLE REPORT ERROR:",
      err.message
    );

    return res.status(500).json({
      ok: false,
      error: err.message
    });

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

    await saveSensorEvent(
      "LORAWAN",
      devEui,
      devName,
      eventKey || "unknown",
      body
    );

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
    const list = getRecipients(cfg.ownerRole || "admin");
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
      locationName: cfg?.location,
      location,
      obj,
    });

    // Envío a todos los destinatarios
    const results = [];
    for (const to of list) {
      try {
        const msg = await twilioClient.messages.create(twilioMessageOptions(to, text));
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

/*
=========================================
BLE MQTT
=========================================
*/

const mqttClient = mqtt.connect(
  process.env.MQTT_URL || "mqtt://lorawan.duke-villa.com:1883"
);

mqttClient.on("connect", () => {

  log("BLE MQTT conectado");

  mqttClient.subscribe("/gw/+/status", (err) => {

    if (err) {
      log("BLE MQTT subscribe ERROR", err.message);
    } else {
      log("BLE MQTT suscrito a /gw/+/status");
    }

  });

});

mqttClient.on("error", (err) => {
  log("BLE MQTT ERROR", err.message);
});

function decodeMinewOccupancy(raw) {

  if (!raw || raw.length < 62) {
    return null;
  }

  const b = [];

  for (let i = 0; i < raw.length; i += 2) {
    b.push(
      parseInt(
        raw.substring(i, i + 2),
        16
      )
    );
  }

  const status = b[13];

  return {

    frame_version: b[8],

    serial: b[10],

    distance_mm:
      b[11] |
      (b[12] << 8),

    status_byte: status,

    low_battery:
      (status & 0x08) !== 0,

    occupied:
      (status & 0x04) !== 0,

    infrared:
      (status & 0x02) !== 0,

    dismantle:
      (status & 0x01) !== 0,

    occupy_count: b[14],

    dismantle_count: b[15]

  };

}

async function processBleGatewayPacket(topic, bleBody) {

  if (!Array.isArray(bleBody.adv)) {
    return;
  }

  for (const adv of bleBody.adv) {

    const mac = String(adv.mac || "").toLowerCase();

    if (!BLE_DEVICES[mac]) {
      continue;
    }

    const baseEvent = {
      gateway: bleBody.gw || null,
      gateway_time: bleBody.tm || null,
      gateway_seq: bleBody.seq || null,
      sensor_name: BLE_DEVICES[mac],
      mac: mac,
      type: adv.type || "unknown",
      rssi: adv.rssi ?? null,
      adv_time: adv.tm || null
    };

    if (adv.type === "other") {

      const decoded =
        decodeMinewOccupancy(
          adv.raw
        );

      const event = {
        ...baseEvent,

        raw: adv.raw || null,

        telemetry: decoded
      };

      console.log(
        "[BLE OCC]",
        event.sensor_name,
        decoded
      );

      await saveSensorEvent(
        "BLE",
        mac,
        topic,
        "ble_occ",
        event
      );

      continue;
    }

    if (adv.type === "info_v3") {

      const event = {
        ...baseEvent,

        telemetry: {
          battery: adv.battery ?? null,
          firmware: adv.ver || null,
          screen: adv.screen || null,
          product: adv.product || null
        }
      };

      console.log(
        "[BLE INFO]",
        event.sensor_name,
        `battery=${event.telemetry?.battery}`,
        `fw=${event.telemetry?.firmware}`,
        `product=${event.telemetry?.product}`
      );

      await saveSensorEvent(
        "BLE",
        mac,
        topic,
        "ble_info",
        event
      );

      continue;
    }

    console.log(
      "[BLE UNKNOWN]",
      BLE_DEVICES[mac],
      adv.type
    );

  }

}

mqttClient.on("message", async (topic, payload) => {

  console.log(
    "[BLE]",
    topic,
    payload.toString().substring(0,300)
  );

  try {

    const bleBody = JSON.parse(
      payload.toString()
    );

    await saveSensorEvent(
      "BLE",
      topic,
      topic,
      "ble_scan",
      bleBody
    );

    await processBleGatewayPacket(
      topic,
      bleBody
    );

  } catch(err) {

    console.error(
      "BLE SAVE ERROR",
      err.message
    );

  }

});

/*
=========================================
DATABASE INIT
=========================================
*/

async function initDatabase() {

  await db.query(`

    CREATE TABLE IF NOT EXISTS sensor_history (

      id BIGSERIAL PRIMARY KEY,

      ts TIMESTAMPTZ NOT NULL,

      source TEXT NOT NULL,

      sensor_id TEXT NOT NULL,

      sensor_name TEXT,

      event_type TEXT,

      payload JSONB NOT NULL

    );

  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sensor_settings (
      sensor_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      threshold DOUBLE PRECISION,
      location TEXT NOT NULL DEFAULT '',
      owner_role TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE sensor_settings ADD COLUMN IF NOT EXISTS owner_role TEXT`);
  await db.query(`UPDATE sensor_settings SET owner_role='admin' WHERE enabled=TRUE AND owner_role IS NULL`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_recipients (
      role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
      phone TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (role, phone)
    );
  `);

  const settings = await db.query(`SELECT sensor_id, name, enabled, lat, lng, threshold, location, owner_role FROM sensor_settings`);
  for (const row of settings.rows) {
    const dev = String(row.sensor_id).toLowerCase();
    if (!HOUSE_MAP[dev]) continue;
    HOUSE_MAP[dev] = row.name || HOUSE_MAP[dev];
    SENSOR_CONFIG[dev] = {
      ...(SENSOR_CONFIG[dev] || {}), enabled: row.enabled, lat: row.lat, lng: row.lng,
      threshold: row.threshold ?? SENSOR_CONFIG[dev]?.threshold, location: row.location || "", ownerRole: row.owner_role || null,
    };
  }

  const savedRecipients = await db.query(`SELECT role, phone FROM whatsapp_recipients`);
  for (const row of savedRecipients.rows) recipientsByRole[row.role]?.add(row.phone);

  log("sensor_history + sensor_settings + whatsapp_recipients OK");

}

/*
=========================================
SAVE SENSOR EVENT
=========================================
*/

async function saveSensorEvent(
  source,
  sensorId,
  sensorName,
  eventType,
  payload
) {

  try {

    await db.query(
      `
      INSERT INTO sensor_history
      (
        ts,
        source,
        sensor_id,
        sensor_name,
        event_type,
        payload
      )
      VALUES
      (
        NOW(),
        $1,
        $2,
        $3,
        $4,
        $5
      )
      `,
      [
        source,
        sensorId,
        sensorName,
        eventType,
        payload
      ]
    );

    console.log(
      "DB SAVE",
      source,
      sensorId,
      sensorName,
      eventType
    );

  } catch(err) {

    console.error(
      "SAVE EVENT ERROR",
      err
    );

  }

}

initDatabase()
  .then(() => {

    app.listen(port, () => {
      log(`listening on ${port}`);
    });

  })
  .catch(err => {

    console.error(
      "DATABASE INIT ERROR",
      err
    );

  });
