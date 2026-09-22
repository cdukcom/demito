const test = require("node:test");
const assert = require("node:assert/strict");
const { createRak2461Config, enqueueOutput, outputPayload } = require("../rak2461-actuator");

test("builds the documented RAK2461 DO commands", () => {
  assert.equal(outputPayload(0xd1, false).toString("hex"), "d10100");
  assert.equal(outputPayload(0xd1, true).toString("hex"), "d10101");
});

test("stays disabled safely when laboratory variables are absent", () => {
  const config = createRak2461Config({});
  assert.equal(config.enabled, false);
  assert.equal(config.releaseMs, 300000);
  assert.equal(config.channelId, 0xd1);
});

test("requires all integration variables when enabled", () => {
  assert.throws(
    () => createRak2461Config({ RAK2461_ENABLED: "true" }),
    /CHIRPSTACK_API_URL.*CHIRPSTACK_API_TOKEN.*RAK2461_DEV_EUI.*RAK2461_TRIGGER_DEV_EUIS/
  );
});

test("enqueues a confirmed Class C downlink on FPort 1", async () => {
  const config = createRak2461Config({
    RAK2461_ENABLED: "true",
    CHIRPSTACK_API_URL: "https://lorawan.example.com/",
    CHIRPSTACK_API_TOKEN: "secret",
    RAK2461_DEV_EUI: "0011223344556677",
    RAK2461_TRIGGER_DEV_EUIS: "ffffff100004f737",
  });
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, text: async () => '{"id":"1"}' };
  };

  await enqueueOutput(config, false, fakeFetch);

  assert.equal(request.url, "https://lorawan.example.com/api/devices/0011223344556677/queue");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.options.body), {
    queueItem: {
      devEui: "0011223344556677",
      confirmed: true,
      fPort: 1,
      data: Buffer.from("d10100", "hex").toString("base64"),
    },
  });
});
