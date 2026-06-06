const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { decryptText, encryptText, hashPassword, hashToken, randomId } = require("./security");

const LEVELS = ["trace", "debug", "info", "warn", "error", "exception", "fatal"];
const EVENT_ID_DEDUPE_SCAN_LIMIT = 100000;

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.logsDir = path.join(dataDir, "logs");
    this.usersFile = path.join(dataDir, "users.json");
    this.projectsFile = path.join(dataDir, "projects.json");
    this.secretsFile = path.join(dataDir, "secrets.json");
    this.logAppendLocks = new Map();
  }

  async init() {
    await fs.mkdir(this.logsDir, { recursive: true });
    await this.ensureJson(this.usersFile, []);
    await this.ensureJson(this.projectsFile, []);
    await this.ensureJson(this.secretsFile, {});
    await this.ensureAdminUser();
    await this.ensureSecret();
  }

  async ensureJson(file, fallback) {
    if (!fsSync.existsSync(file)) {
      await this.writeJson(file, fallback);
    }
  }

  async readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async writeJson(file, value) {
    const body = JSON.stringify(value, null, 2);
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const tmp = `${file}.${process.pid}.${Date.now()}.${randomId(4)}.tmp`;
      try {
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, file);
        return;
      } catch (error) {
        lastError = error;
        await fs.rm(tmp, { force: true }).catch(() => {});
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) break;
        await sleep(40 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async ensureAdminUser() {
    const users = await this.readJson(this.usersFile, []);
    if (users.length > 0) return;

    users.push({
      id: randomId(8),
      email: "admin@easylog.local",
      name: "Administrator",
      role: "admin",
      passwordHash: hashPassword(process.env.EASYLOG_ADMIN_PASSWORD || "admin1234"),
      createdAt: new Date().toISOString()
    });
    await this.writeJson(this.usersFile, users);
  }

  async ensureSecret() {
    const secrets = await this.readJson(this.secretsFile, {});
    if (!secrets.authSecret) {
      secrets.authSecret = process.env.EASYLOG_AUTH_SECRET || randomId(32);
      await this.writeJson(this.secretsFile, secrets);
    }
    this.authSecret = process.env.EASYLOG_AUTH_SECRET || secrets.authSecret;
  }

  async listUsers() {
    return (await this.readJson(this.usersFile, [])).map(({ passwordHash, ...user }) => user);
  }

  async findUserByEmail(email) {
    const users = await this.readJson(this.usersFile, []);
    return users.find((user) => user.email.toLowerCase() === String(email || "").toLowerCase()) || null;
  }

  async findUserById(id) {
    const users = await this.readJson(this.usersFile, []);
    return users.find((user) => user.id === id) || null;
  }

  async createUser(input) {
    const users = await this.readJson(this.usersFile, []);
    if (users.some((user) => user.email.toLowerCase() === input.email.toLowerCase())) {
      throw new AppError(409, "USER_EXISTS", "User email already exists.");
    }

    const user = {
      id: randomId(8),
      email: input.email.trim(),
      name: input.name?.trim() || input.email.trim(),
      role: input.role === "admin" ? "admin" : "developer",
      passwordHash: hashPassword(input.password),
      createdAt: new Date().toISOString()
    };
    users.push(user);
    await this.writeJson(this.usersFile, users);
    const { passwordHash, ...safeUser } = user;
    return safeUser;
  }

  async listProjects() {
    return this.readJson(this.projectsFile, []);
  }

  async getProject(projectId) {
    const projects = await this.listProjects();
    return projects.find((project) => project.id === projectId) || null;
  }

  async createProject(input, userId) {
    const projects = await this.listProjects();
    const project = {
      id: randomId(8),
      name: String(input.name || "").trim(),
      retentionDays: clampInt(input.retentionDays, 1, 365, 30),
      createdBy: userId,
      createdAt: new Date().toISOString(),
      tokens: []
    };
    if (!project.name) throw new AppError(400, "PROJECT_NAME_REQUIRED", "Project name is required.");
    projects.push(project);
    await this.writeJson(this.projectsFile, projects);
    return project;
  }

  async createProjectToken(projectId, name) {
    const projects = await this.listProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project was not found.");

    const rawToken = `el_${projectId}_${randomId(24)}`;
    const token = {
      id: randomId(8),
      name: String(name || "Default token").trim(),
      prefix: rawToken.slice(0, 16),
      tokenHash: hashToken(rawToken),
      encryptedToken: encryptText(rawToken, this.authSecret),
      createdAt: new Date().toISOString(),
      disabledAt: null
    };
    project.tokens.push(token);
    await this.writeJson(this.projectsFile, projects);
    return { token: rawToken, tokenInfo: withoutTokenHash(token) };
  }

  async revealProjectToken(projectId, tokenId) {
    const projects = await this.listProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project was not found.");

    const token = project.tokens.find((item) => item.id === tokenId);
    if (!token) throw new AppError(404, "TOKEN_NOT_FOUND", "Token was not found.");
    if (!token.encryptedToken) {
      throw new AppError(409, "TOKEN_NOT_REVEALABLE", "This older token cannot be copied. Generate a new token instead.");
    }

    const rawToken = decryptText(token.encryptedToken, this.authSecret);
    if (!rawToken) throw new AppError(500, "TOKEN_DECRYPT_FAILED", "Token could not be decrypted.");
    return { token: rawToken, tokenInfo: withoutTokenHash(token) };
  }

  async deleteProjectToken(projectId, tokenId) {
    const projects = await this.listProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project was not found.");

    const before = project.tokens.length;
    project.tokens = project.tokens.filter((token) => token.id !== tokenId);
    if (project.tokens.length === before) {
      throw new AppError(404, "TOKEN_NOT_FOUND", "Token was not found.");
    }

    await this.writeJson(this.projectsFile, projects);
    return true;
  }

  async findProjectByIngestToken(rawToken) {
    if (!rawToken) return null;
    const projects = await this.listProjects();
    const tokenHash = hashToken(rawToken);
    for (const project of projects) {
      const token = project.tokens.find((item) => item.tokenHash === tokenHash && !item.disabledAt);
      if (token) return { project, token };
    }
    return null;
  }

  async appendLogs(projectId, logs) {
    return this.withProjectLogLock(projectId, async () => {
      const received = Array.isArray(logs) ? logs.length : 0;
      if (received === 0) return { received: 0, accepted: 0, deduplicated: 0 };

      const wantedEventIds = new Set();
      for (const log of logs) {
        if (log.eventId) wantedEventIds.add(log.eventId);
      }

      const existingEventIds = wantedEventIds.size > 0 ? await this.findRecentEventIds(projectId, wantedEventIds) : new Set();
      const seenEventIds = new Set();
      const acceptedLogs = [];
      let deduplicated = 0;

      for (const log of logs) {
        if (log.eventId) {
          if (existingEventIds.has(log.eventId) || seenEventIds.has(log.eventId)) {
            deduplicated += 1;
            continue;
          }
          seenEventIds.add(log.eventId);
        }
        acceptedLogs.push(log);
      }

      if (acceptedLogs.length > 0) {
        const file = this.projectLogFile(projectId);
        const lines = acceptedLogs.map((log) => JSON.stringify(log)).join("\n") + "\n";
        await fs.appendFile(file, lines, "utf8");
      }

      return { received, accepted: acceptedLogs.length, deduplicated };
    });
  }

  async findRecentEventIds(projectId, wantedEventIds) {
    const found = new Set();
    for await (const log of this.readLogs(projectId, EVENT_ID_DEDUPE_SCAN_LIMIT)) {
      if (log.eventId && wantedEventIds.has(log.eventId)) {
        found.add(log.eventId);
        if (found.size === wantedEventIds.size) break;
      }
    }
    return found;
  }

  async withProjectLogLock(projectId, action) {
    const previous = this.logAppendLocks.get(projectId) || Promise.resolve();
    let release = () => {};
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.logAppendLocks.set(projectId, tail);

    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
      if (this.logAppendLocks.get(projectId) === tail) {
        this.logAppendLocks.delete(projectId);
      }
    }
  }

  async queryLogs(projectId, query) {
    const project = await this.getProject(projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project was not found.");

    const filters = parseLogFilters(query);
    const maxScan = clampInt(query.maxScan, 1000, 250000, 100000);
    const offset = clampInt(query.offset, 0, 1000000, 0);
    const limit = clampInt(query.limit, 1, 500, 100);
    const items = [];
    let total = 0;
    let scanned = 0;

    for await (const log of this.readLogs(projectId, maxScan)) {
      scanned += 1;
      if (!matchesLog(log, filters)) continue;
      total += 1;
      if (total > offset && items.length < limit) items.push(log);
    }

    return { items, total, limit, offset, scanned };
  }

  async exportLogs(projectId, query) {
    const project = await this.getProject(projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project was not found.");

    const filters = parseLogFilters(query);
    const maxRows = clampInt(query.maxRows || query.limit, 1, 10000, 10000);
    const rows = [];

    for await (const log of this.readLogs(projectId, 250000)) {
      if (!matchesLog(log, filters)) continue;
      rows.push(log);
      if (rows.length >= maxRows) break;
    }

    return rows;
  }

  async getProjectStats(projectId) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    let total24h = 0;
    let errors24h = 0;
    let sessions24h = new Set();

    for await (const log of this.readLogs(projectId, 100000)) {
      const time = Date.parse(log.timestamp || log.receivedAt || 0);
      if (Number.isNaN(time) || time < since) continue;
      total24h += 1;
      if (["error", "exception", "fatal"].includes(log.level)) errors24h += 1;
      if (log.sessionId) sessions24h.add(log.sessionId);
    }

    return { total24h, errors24h, sessions24h: sessions24h.size };
  }

  async *readLogs(projectId, maxLines) {
    const file = this.projectLogFile(projectId);
    if (!fsSync.existsSync(file)) return;

    const content = await fs.readFile(file, "utf8");
    const lines = content.trimEnd().split(/\r?\n/).reverse();
    let count = 0;
    for (const line of lines) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
        count += 1;
      } catch {
        continue;
      }
      if (count >= maxLines) break;
    }
  }

  async pruneRetention() {
    const projects = await this.listProjects();
    for (const project of projects) {
      const retentionMs = project.retentionDays * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - retentionMs;
      const kept = [];
      for await (const log of this.readLogs(project.id, 500000)) {
        const time = Date.parse(log.timestamp || log.receivedAt || 0);
        if (!Number.isNaN(time) && time >= cutoff) kept.push(log);
      }
      kept.reverse();
      await fs.writeFile(this.projectLogFile(project.id), kept.map((log) => JSON.stringify(log)).join("\n") + (kept.length ? "\n" : ""));
    }
  }

  projectLogFile(projectId) {
    return path.join(this.logsDir, `${projectId}.jsonl`);
  }
}

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function withoutTokenHash(token) {
  const { tokenHash, encryptedToken, ...safeToken } = token;
  return {
    ...safeToken,
    canCopy: Boolean(encryptedToken)
  };
}

function sanitizeProject(project) {
  return {
    ...project,
    tokens: project.tokens.map(withoutTokenHash)
  };
}

function normalizeLog(projectId, input) {
  const now = new Date().toISOString();
  const timestamp = normalizeTimestamp(input.timestamp || input.clientTimestamp || input.time) || now;
  const level = normalizeLevel(input.level || input.type || "info");
  const message = maskText(String(input.message || input.msg || input.body || ""));

  return {
    id: randomId(10),
    eventId: stringOrEmpty(input.eventId || input.event_id || input.clientEventId),
    projectId,
    timestamp,
    receivedAt: now,
    level,
    message: message.slice(0, 20000),
    stackTrace: maskText(String(input.stackTrace || input.stack || "")).slice(0, 80000),
    category: stringOrEmpty(input.category),
    playerId: stringOrEmpty(input.playerId || input.userId || input.accountId),
    sessionId: stringOrEmpty(input.sessionId),
    buildVersion: stringOrEmpty(input.buildVersion || input.version),
    platform: stringOrEmpty(input.platform),
    scene: stringOrEmpty(input.scene),
    deviceId: stringOrEmpty(input.deviceId),
    custom: maskObject(input.custom || input.attributes || {})
  };
}

function parseLogFilters(query) {
  const from = query.from ? Date.parse(query.from) : Date.now() - 60 * 60 * 1000;
  const to = query.to ? Date.parse(query.to) : Date.now();
  return {
    from: Number.isNaN(from) ? Date.now() - 60 * 60 * 1000 : from,
    to: Number.isNaN(to) ? Date.now() : to,
    level: normalizeLevel(query.level || ""),
    q: String(query.q || "").trim().toLowerCase(),
    playerId: String(query.playerId || "").trim().toLowerCase(),
    sessionId: String(query.sessionId || "").trim().toLowerCase(),
    buildVersion: String(query.buildVersion || "").trim().toLowerCase(),
    platform: String(query.platform || "").trim().toLowerCase(),
    scene: String(query.scene || "").trim().toLowerCase(),
    category: String(query.category || "").trim().toLowerCase()
  };
}

function matchesLog(log, filters) {
  const time = Date.parse(log.timestamp || log.receivedAt || 0);
  if (Number.isNaN(time) || time < filters.from || time > filters.to) return false;
  if (filters.level && log.level !== filters.level) return false;
  if (filters.playerId && !String(log.playerId || "").toLowerCase().includes(filters.playerId)) return false;
  if (filters.sessionId && !String(log.sessionId || "").toLowerCase().includes(filters.sessionId)) return false;
  if (filters.buildVersion && !String(log.buildVersion || "").toLowerCase().includes(filters.buildVersion)) return false;
  if (filters.platform && !String(log.platform || "").toLowerCase().includes(filters.platform)) return false;
  if (filters.scene && !String(log.scene || "").toLowerCase().includes(filters.scene)) return false;
  if (filters.category && !String(log.category || "").toLowerCase().includes(filters.category)) return false;
  if (filters.q) {
    const haystack = `${log.eventId || ""}\n${log.message || ""}\n${log.stackTrace || ""}\n${JSON.stringify(log.custom || {})}`.toLowerCase();
    if (!haystack.includes(filters.q)) return false;
  }
  return true;
}

function normalizeTimestamp(value) {
  if (!value) return "";
  if (typeof value === "number") {
    const ms = value > 9999999999 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function normalizeLevel(value) {
  const text = String(value || "").toLowerCase();
  if (text === "warning") return "warn";
  if (text === "log" || text === "information") return "info";
  if (text === "critical") return "fatal";
  return LEVELS.includes(text) ? text : "";
}

function maskObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/password|token|secret|authorization|apikey|api_key/i.test(key)) {
      output[key] = "[redacted]";
    } else if (raw && typeof raw === "object") {
      output[key] = maskObject(raw);
    } else if (typeof raw === "string") {
      output[key] = maskText(raw).slice(0, 5000);
    } else {
      output[key] = raw;
    }
  }
  return output;
}

function maskText(value) {
  return value
    .replace(/(authorization|bearer|token|api[_-]?key|password)\s*[:=]\s*["']?[^"'\s,;]+/gi, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
}

function stringOrEmpty(value) {
  return value == null ? "" : String(value).slice(0, 500);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  AppError,
  Store,
  normalizeLog,
  sanitizeProject
};
