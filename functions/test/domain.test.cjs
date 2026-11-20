const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRedemptionCode,
  applyRedemption,
  decryptValue,
  encryptValue,
  hashSecret,
  isSameRedemption,
  normalizeRedemptionCode,
  parseNewOrder,
  validateAccessToken,
  validateRequestId
} = require("../lib/domain.js");
const { createCertificatePdf } = require("../lib/certificate.js");
const {
  nextRateLimitState,
  rateLimitDocumentId,
  RateLimitExceeded
} = require("../lib/rate-limit.js");

const order = {
  amountCents: 5000,
  purchaserName: "Ada Example",
  purchaserEmail: "ada@example.com",
  recipientName: "Grace Example",
  recipientEmail: "grace@example.com",
  recipientType: "other",
  message: "Happy birthday"
};

test("validates and normalizes a gift card order", () => {
  assert.deepEqual(parseNewOrder(order), { ...order, purchaserEmail: "ada@example.com", recipientEmail: "grace@example.com" });
});

test("uses purchaser details as recipient details for self-purchases", () => {
  const parsed = parseNewOrder({ ...order, recipientType: "self", recipientName: "ignored", recipientEmail: "ignored@example.com" });
  assert.equal(parsed.recipientName, order.purchaserName);
  assert.equal(parsed.recipientEmail, order.purchaserEmail);
});

test("rejects fractional cents, invalid email, and oversized messages", () => {
  assert.throws(() => parseNewOrder({ ...order, amountCents: 5000.5 }));
  assert.throws(() => parseNewOrder({ ...order, purchaserEmail: "not-an-email" }));
  assert.throws(() => parseNewOrder({ ...order, message: "x".repeat(501) }));
});

test("validates access tokens and generates valid redemption codes", () => {
  const token = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(validateAccessToken(token), token);
  assert.throws(() => validateAccessToken("weak-token"));
  const code = createRedemptionCode();
  assert.match(code, /^MHT(?:-[A-F0-9]{4}){8}$/);
  assert.equal(normalizeRedemptionCode(code.replaceAll("-", " ")), code.replaceAll("-", ""));
  assert.notEqual(hashSecret(code), hashSecret(createRedemptionCode()));
  assert.throws(() => normalizeRedemptionCode("MHT-123"));
});

test("generates a non-empty PDF certificate", async () => {
  const pdf = await createCertificatePdf({
    code: createRedemptionCode(),
    amountCents: 5000,
    recipientName: "Grace Example",
    message: "Happy birthday",
    issuedAt: new Date("2026-01-01T00:00:00.000Z")
  });
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(pdf.length > 1000);
});

test("encrypts certificate codes and rejects tampering or invalid keys", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptValue("MHT-REDEMPTION-CODE", key);
  assert.notEqual(encrypted.ciphertext, "MHT-REDEMPTION-CODE");
  assert.equal(decryptValue(encrypted, key), "MHT-REDEMPTION-CODE");
  assert.throws(() => decryptValue(encrypted, Buffer.alloc(32, 8).toString("base64")));
  assert.throws(() => encryptValue("code", "not-a-key"));
});

test("rate limits by minute, hour, day, and weighted requests", () => {
  const start = Date.UTC(2026, 0, 1, 12, 0, 0);
  const rules = { perMinute: 2, perHour: 3, perDay: 4 };
  let state = nextRateLimitState(undefined, start, rules);
  state = nextRateLimitState(state, start + 1, rules);
  assert.throws(() => nextRateLimitState(state, start + 2, rules), RateLimitExceeded);
  state = nextRateLimitState(state, start + 60_000, rules);
  assert.throws(() => nextRateLimitState(state, start + 60_001, rules, 2), RateLimitExceeded);
  const tomorrow = nextRateLimitState(state, start + 24 * 60 * 60 * 1000, rules);
  assert.equal(tomorrow.dayCount, 1);
});

test("rate limit keys are stable but do not expose client identifiers", () => {
  const key = Buffer.alloc(32, 3).toString("base64");
  const id = rateLimitDocumentId("order", "203.0.113.12", key);
  assert.equal(id, rateLimitDocumentId("order", "203.0.113.12", key));
  assert.notEqual(id, rateLimitDocumentId("order", "203.0.113.13", key));
  assert.notEqual(id, rateLimitDocumentId("order", "203.0.113.12", Buffer.alloc(32, 4).toString("base64")));
  assert.throws(() => rateLimitDocumentId("order", "203.0.113.12", "weak"));
});

test("validates redemption idempotency and prevents over-redemption", () => {
  const requestId = "b06c85a7-5907-45f1-b292-cfcbd55751e2";
  assert.equal(validateRequestId(requestId), requestId);
  assert.throws(() => validateRequestId("not-a-uuid"));
  assert.equal(isSameRedemption(undefined, 2500, "studio visit"), false);
  assert.equal(isSameRedemption({ amountCents: 2500, note: "studio visit" }, 2500, "studio visit"), true);
  assert.throws(() => isSameRedemption({ amountCents: 2500, note: "studio visit" }, 3000, "studio visit"));
  assert.equal(applyRedemption(5000, 2500), 2500);
  assert.equal(applyRedemption(2500, 2500), 0);
  assert.throws(() => applyRedemption(2500, 2501));
});
