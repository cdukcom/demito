const DEFAULT_CHANNEL_ID = 0xd1;
const DEFAULT_RELEASE_MS = 5 * 60 * 1000;

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseDevEuis(value) {
  return new Set(String(value || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean));
}

function parseChannelId(value) {
  const input = String(value || "D1").trim();
  const parsed = Number.parseInt(input.replace(/^0x/i, ""), 16);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new Error("RAK2461_CHANNEL_ID debe ser un byte hexadecimal (por ejemplo D1)");
  }
  return parsed;
}

function createRak2461Config(env = process.env) {
  const releaseSeconds = Number.parseInt(env.RAK2461_RELEASE_SECONDS || "300", 10);
  if (!Number.isInteger(releaseSeconds) || releaseSeconds < 5 || releaseSeconds > 86400) {
    throw new Error("RAK2461_RELEASE_SECONDS debe estar entre 5 y 86400");
  }

  const config = {
    enabled: parseBoolean(env.RAK2461_ENABLED),
    apiUrl: String(env.CHIRPSTACK_API_URL || "").trim().replace(/\/$/, ""),
    apiToken: String(env.CHIRPSTACK_API_TOKEN || "").trim(),
    devEui: String(env.RAK2461_DEV_EUI || "").trim().toLowerCase(),
    triggerDevEuis: parseDevEuis(env.RAK2461_TRIGGER_DEV_EUIS),
    channelId: parseChannelId(env.RAK2461_CHANNEL_ID),
    releaseMs: releaseSeconds * 1000,
    retryMs: 30 * 1000,
  };

  if (config.enabled) {
    const missing = [];
    if (!config.apiUrl) missing.push("CHIRPSTACK_API_URL");
    if (!config.apiToken) missing.push("CHIRPSTACK_API_TOKEN");
    if (!/^[0-9a-f]{16}$/.test(config.devEui)) missing.push("RAK2461_DEV_EUI");
    if (config.triggerDevEuis.size === 0) missing.push("RAK2461_TRIGGER_DEV_EUIS");
    if (missing.length) throw new Error(`RAK2461 habilitado pero faltan variables válidas: ${missing.join(", ")}`);
  }

  return config;
}

function outputPayload(channelId, enabled) {
  return Buffer.from([channelId, 0x01, enabled ? 0x01 : 0x00]);
}

async function enqueueOutput(config, enabled, fetchImpl = globalThis.fetch) {
  if (!config.enabled) return { skipped: true, reason: "disabled" };
  if (typeof fetchImpl !== "function") throw new Error("fetch no está disponible");

  const data = outputPayload(config.channelId, enabled).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetchImpl(`${config.apiUrl}/api/devices/${config.devEui}/queue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        queueItem: {
          devEui: config.devEui,
          confirmed: true,
          fPort: 1,
          data,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`ChirpStack rechazó el downlink (${response.status}): ${responseText.slice(0, 300)}`);
  }
  return { ok: true, enabled, data, response: responseText };
}

module.exports = {
  DEFAULT_CHANNEL_ID,
  DEFAULT_RELEASE_MS,
  createRak2461Config,
  enqueueOutput,
  outputPayload,
};
