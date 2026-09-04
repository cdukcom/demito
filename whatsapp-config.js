const VALID_MODES = new Set(["production", "sandbox", "disabled"]);

function normalizeSender(value) {
  const sender = String(value || "").trim();
  if (!sender) return "";
  return sender.startsWith("whatsapp:") ? sender : `whatsapp:${sender}`;
}

function normalizeMode(value, fallback, variableName) {
  const mode = String(value || fallback).trim().toLowerCase();
  if (!VALID_MODES.has(mode)) {
    throw new Error(`${variableName} debe ser production, sandbox o disabled`);
  }
  return mode;
}

function createWhatsAppConfig(env = process.env) {
  const productionFrom = normalizeSender(env.WHATSAPP_FROM);
  const sandboxFrom = normalizeSender(env.WHATSAPP_SANDBOX_FROM || "+14155238886");
  const contentSid = String(env.TWILIO_CONTENT_SID || "").trim();
  const modes = {
    admin: normalizeMode(env.WHATSAPP_MODE_ADMIN, "production", "WHATSAPP_MODE_ADMIN"),
    guest: normalizeMode(env.WHATSAPP_MODE_GUEST, "sandbox", "WHATSAPP_MODE_GUEST"),
  };

  function channelForRole(role = "admin") {
    const normalizedRole = role === "guest" ? "guest" : "admin";
    const mode = modes[normalizedRole];
    const from = mode === "production" ? productionFrom : mode === "sandbox" ? sandboxFrom : "";
    return { role: normalizedRole, mode, from };
  }

  function messageOptions(to, body, variables = null, role = "admin") {
    const channel = channelForRole(role);
    if (channel.mode === "disabled") {
      throw new Error(`WhatsApp está deshabilitado para el rol ${channel.role}`);
    }
    if (!channel.from) {
      const variable = channel.mode === "production" ? "WHATSAPP_FROM" : "WHATSAPP_SANDBOX_FROM";
      throw new Error(`Falta ${variable} para el rol ${channel.role}`);
    }

    const base = { from: channel.from, to };
    if (channel.mode !== "production" || !contentSid || !variables) {
      return { ...base, body };
    }
    return {
      ...base,
      contentSid,
      contentVariables: JSON.stringify(variables),
    };
  }

  return { productionFrom, sandboxFrom, contentSid, modes, channelForRole, messageOptions };
}

module.exports = { createWhatsAppConfig, normalizeSender };
