const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/storage");

test("project tokens can be deleted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "easylog-test-"));
  try {
    const store = new Store(dir);
    await store.init();
    const project = await store.createProject({ name: "Token test" }, "u1");
    const created = await store.createProjectToken(project.id, "Unity");

    assert.ok(await store.findProjectByIngestToken(created.token));
    assert.equal(created.tokenInfo.canCopy, true);
    assert.equal(created.tokenInfo.tokenHash, undefined);
    assert.equal(created.tokenInfo.encryptedToken, undefined);

    const revealed = await store.revealProjectToken(project.id, created.tokenInfo.id);
    assert.equal(revealed.token, created.token);

    await store.deleteProjectToken(project.id, created.tokenInfo.id);

    const updated = await store.getProject(project.id);
    assert.equal(updated.tokens.length, 0);
    assert.equal(await store.findProjectByIngestToken(created.token), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("logs with duplicate event ids are deduplicated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "easylog-test-"));
  try {
    const store = new Store(dir);
    await store.init();
    const project = await store.createProject({ name: "Dedupe test" }, "u1");

    const first = {
      id: "server-1",
      eventId: "session-a-1",
      projectId: project.id,
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      level: "info",
      message: "first"
    };
    const duplicateInBatch = { ...first, id: "server-2", message: "duplicate in batch" };
    const second = {
      id: "server-3",
      eventId: "session-a-2",
      projectId: project.id,
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      level: "info",
      message: "second"
    };

    assert.deepEqual(await store.appendLogs(project.id, [first, duplicateInBatch, second]), {
      received: 3,
      accepted: 2,
      deduplicated: 1
    });

    const duplicateInLaterBatch = { ...first, id: "server-4", message: "duplicate later" };
    const withoutEventId = {
      id: "server-5",
      eventId: "",
      projectId: project.id,
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      level: "info",
      message: "legacy client"
    };

    assert.deepEqual(await store.appendLogs(project.id, [duplicateInLaterBatch, withoutEventId]), {
      received: 2,
      accepted: 1,
      deduplicated: 1
    });

    const result = await store.queryLogs(project.id, { limit: 10 });
    assert.equal(result.total, 3);
    assert.equal(result.items.some((log) => log.message === "duplicate in batch"), false);
    assert.equal(result.items.some((log) => log.message === "duplicate later"), false);
    assert.equal(result.items.some((log) => log.message === "legacy client"), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
