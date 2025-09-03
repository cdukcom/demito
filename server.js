import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const {
  TWILIO_SID,
  TWILIO_TOKEN,
  WHATSAPP_FROM,
  WHATSAPP_TO,
  SHARED_SECRET,         // para validar que el POST venga de ChirpStack
  MIN_SECONDS_BETWEEN,   // rate limit por dispositivo (opcional)
} = process.env;

const client = twilio(TWILIO_SID, TWILIO_TOKEN);
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: "1mb" }));

// anti-spam básico por devEUI
const lastSent = new Map();
const MIN_GAP = Number(MIN_SECONDS_BETWEEN || 60); // 60s por defecto

app.get("/health", (_,res)=>res.send("ok"));

app.post("/uplink", async (req, res) => {
  try {
    // 1) seguridad simple por header
    const hdr = req.header("x-secret");
    if (SHARED_SECRET && hdr !== SHARED_SECRET) {
      return res.status(401).json({ ok:false, error:"unauthorized" });
    }

    // 2) ChirpStack v4 uplink payload típico
    const evt = req.body; // JSON
    // campos comunes:
    // evt.deviceInfo.devEui, evt.fCnt, evt.object (si tienes codec), evt.rxInfo, evt.txInfo...

    const devEui = evt?.deviceInfo?.devEui || "unknown";
    const fCnt  = evt?.fCnt;
    const obj   = evt?.object || {}; // requiere codec configurado en ChirpStack
    const ts    = evt?.time || new Date().toISOString();

    // 3) Lógica de disparo: ajusta al campo que ponga tu codec (por ejemplo "panic": true)
    //    Si no usas codec, puedes leer evt.data (base64) y decodificar aquí.
    const panic = obj.panic === true || obj.button === "pressed" || obj.alert === 1;

    if (!panic) {
      return res.json({ ok:true, skipped:"no panic flag" });
    }

    // 4) Rate-limit por dispositivo para evitar spam
    const now = Date.now();
    const last = lastSent.get(devEui) || 0;
    if ((now - last)/1000 < MIN_GAP) {
      return res.json({ ok:true, skipped:`rate-limited (${MIN_GAP}s)` });
    }
    lastSent.set(devEui, now);

    // 5) Construye mensaje
    const name  = evt?.deviceInfo?.name || devEui;
    const batt  = (obj.battery != null) ? ` | Batería: ${obj.battery}%` : "";
    const gw    = evt?.rxInfo?.[0]?.gatewayId ? ` | GW: ${evt.rxInfo[0].gatewayId}` : "";
    const where = (obj.lat && obj.lng) ? ` | Pos: ${obj.lat},${obj.lng}` : "";

    const body = `🚨 *Botón de pánico*`
      + `\nDispositivo: ${name}`
      + `\nDevEUI: ${devEui}`
      + `\nFCnt: ${fCnt ?? "?"}`
      + `\nHora: ${ts}${batt}${gw}${where}`;

    // 6) Enviar a múltiples destinatarios
    const tos = (WHATSAPP_TO || "").split(",").map(s => s.trim()).filter(Boolean);
    const results = [];
    for (const to of tos) {
      const r = await client.messages.create({
        from: WHATSAPP_FROM,
        to,
        body
      });
      results.push({ to, sid: r.sid });
    }

    res.json({ ok:true, sent: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

app.listen(port, ()=>console.log(`listening on ${port}`));
