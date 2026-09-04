const test = require("node:test");
const assert = require("node:assert/strict");
const { createWhatsAppConfig } = require("../whatsapp-config");

const baseEnv = {
  WHATSAPP_FROM: "+15550001111",
  WHATSAPP_SANDBOX_FROM: "+14155238886",
  TWILIO_CONTENT_SID: "HXtest",
};

test("defaults preserve the current hybrid setup", () => {
  const config = createWhatsAppConfig(baseEnv);
  assert.deepEqual(config.modes, { admin: "production", guest: "sandbox" });
  assert.equal(config.channelForRole("admin").from, "whatsapp:+15550001111");
  assert.equal(config.channelForRole("guest").from, "whatsapp:+14155238886");
});

test("production uses the approved template when variables exist", () => {
  const config = createWhatsAppConfig(baseEnv);
  const options = config.messageOptions("whatsapp:+573000000000", "fallback", { "1": "evento" }, "admin");
  assert.equal(options.contentSid, "HXtest");
  assert.equal(options.body, undefined);
  assert.equal(options.contentVariables, JSON.stringify({ "1": "evento" }));
});

test("sandbox always uses a free-form body", () => {
  const config = createWhatsAppConfig(baseEnv);
  const options = config.messageOptions("whatsapp:+573000000000", "alerta", { "1": "evento" }, "guest");
  assert.deepEqual(options, {
    from: "whatsapp:+14155238886",
    to: "whatsapp:+573000000000",
    body: "alerta",
  });
});

test("roles can be switched to sandbox for a quick rollback", () => {
  const config = createWhatsAppConfig({
    ...baseEnv,
    WHATSAPP_MODE_ADMIN: "sandbox",
    WHATSAPP_MODE_GUEST: "sandbox",
  });
  assert.equal(config.channelForRole("admin").from, "whatsapp:+14155238886");
  assert.equal(config.channelForRole("guest").from, "whatsapp:+14155238886");
});

test("invalid modes fail at startup instead of silently choosing a sender", () => {
  assert.throws(
    () => createWhatsAppConfig({ ...baseEnv, WHATSAPP_MODE_ADMIN: "prod" }),
    /WHATSAPP_MODE_ADMIN debe ser production, sandbox o disabled/,
  );
});
