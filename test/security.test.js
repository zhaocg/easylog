const test = require("node:test");
const assert = require("node:assert/strict");
const { hashPassword, signJwt, verifyJwt, verifyPassword } = require("../src/security");
const { normalizeLog } = require("../src/storage");

test("passwords are hashed and verified", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong", hash), false);
});

test("jwt payload is signed and decoded", () => {
  const secret = "test-secret";
  const token = signJwt({ sub: "u1", role: "admin" }, secret, 60);
  const payload = verifyJwt(token, secret);
  assert.equal(payload.sub, "u1");
  assert.equal(payload.role, "admin");
});

test("logs are normalized and sensitive data is redacted", () => {
  const log = normalizeLog("p1", {
    level: "Warning",
    message: "token=abc123 user test@example.com",
    custom: { password: "secret", score: 42 }
  });
  assert.equal(log.level, "warn");
  assert.equal(log.eventId, "");
  assert.match(log.message, /\[redacted\]/);
  assert.match(log.message, /\[email\]/);
  assert.equal(log.custom.password, "[redacted]");
  assert.equal(log.custom.score, 42);
});

test("event ids are normalized for dedupe", () => {
  const log = normalizeLog("p1", {
    eventId: "session-42",
    message: "hello"
  });

  assert.equal(log.eventId, "session-42");
});
