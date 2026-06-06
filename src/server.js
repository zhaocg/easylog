const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const { Store, AppError, normalizeLog, sanitizeProject } = require("./storage");
const { signJwt, verifyJwt, verifyPassword } = require("./security");

const PORT = Number(process.env.PORT || 3100);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.EASYLOG_DATA_DIR || path.join(ROOT, "data");
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const store = new Store(DATA_DIR);

async function main() {
  await store.init();
  await store.pruneRetention().catch((error) => {
    console.warn(`Retention cleanup skipped: ${error.message}`);
  });

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => sendError(res, error));
  });

  server.listen(PORT, () => {
    console.log(`EasyLog running at http://localhost:${PORT}`);
    console.log("Default admin: admin@easylog.local / admin1234");
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";

  if (url.pathname.startsWith("/api/")) {
    await routeApi(req, res, method, url);
    return;
  }

  await routeStatic(res, url.pathname);
}

async function routeApi(req, res, method, url) {
  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    const user = await store.findUserByEmail(body.email);
    if (!user || !verifyPassword(body.password || "", user.passwordHash)) {
      throw new AppError(401, "INVALID_LOGIN", "Invalid email or password.");
    }

    const token = signJwt({ sub: user.id, role: user.role }, store.authSecret);
    sendJson(res, 200, {
      token,
      user: safeUser(user)
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/me") {
    const user = await requireUser(req);
    sendJson(res, 200, { user: safeUser(user) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/users") {
    await requireRole(req, "admin");
    sendJson(res, 200, { users: await store.listUsers() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/users") {
    await requireRole(req, "admin");
    const body = await readJsonBody(req);
    validate(body.email, "Email is required.");
    validate(body.password && body.password.length >= 8, "Password must be at least 8 characters.");
    const user = await store.createUser(body);
    sendJson(res, 201, { user });
    return;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    await requireUser(req);
    const projects = (await store.listProjects()).map(sanitizeProject);
    sendJson(res, 200, { projects });
    return;
  }

  if (method === "POST" && url.pathname === "/api/projects") {
    const user = await requireRole(req, "admin");
    const body = await readJsonBody(req);
    const project = await store.createProject(body, user.id);
    sendJson(res, 201, { project: sanitizeProject(project) });
    return;
  }

  const tokenMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tokens$/);
  if (tokenMatch && method === "POST") {
    await requireRole(req, "admin");
    const body = await readJsonBody(req);
    const result = await store.createProjectToken(tokenMatch[1], body.name);
    sendJson(res, 201, result);
    return;
  }

  const tokenDeleteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tokens\/([^/]+)$/);
  if (tokenDeleteMatch && method === "DELETE") {
    await requireRole(req, "admin");
    await store.deleteProjectToken(tokenDeleteMatch[1], tokenDeleteMatch[2]);
    sendJson(res, 200, { deleted: true });
    return;
  }

  const tokenRevealMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tokens\/([^/]+)\/reveal$/);
  if (tokenRevealMatch && method === "GET") {
    await requireRole(req, "admin");
    const result = await store.revealProjectToken(tokenRevealMatch[1], tokenRevealMatch[2]);
    sendJson(res, 200, result);
    return;
  }

  const statsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/stats$/);
  if (statsMatch && method === "GET") {
    await requireUser(req);
    sendJson(res, 200, await store.getProjectStats(statsMatch[1]));
    return;
  }

  const logsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/logs$/);
  if (logsMatch && method === "GET") {
    await requireUser(req);
    sendJson(res, 200, await store.queryLogs(logsMatch[1], Object.fromEntries(url.searchParams)));
    return;
  }

  const exportMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
  if (exportMatch && method === "GET") {
    await requireUser(req);
    const rows = await store.exportLogs(exportMatch[1], Object.fromEntries(url.searchParams));
    const format = url.searchParams.get("format") === "json" ? "json" : "csv";
    if (format === "json") {
      sendDownload(res, "application/json", `easylog-${exportMatch[1]}.json`, JSON.stringify(rows, null, 2));
    } else {
      sendDownload(res, "text/csv; charset=utf-8", `easylog-${exportMatch[1]}.csv`, toCsv(rows));
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/v1/logs") {
    const rawToken = getBearer(req) || req.headers["x-easylog-token"];
    const match = await store.findProjectByIngestToken(rawToken);
    if (!match) throw new AppError(401, "INVALID_INGEST_TOKEN", "Invalid ingest token.");

    const body = await readJsonBody(req);
    const inputLogs = Array.isArray(body) ? body : Array.isArray(body.logs) ? body.logs : [body];
    if (inputLogs.length > 1000) throw new AppError(413, "TOO_MANY_LOGS", "A single request can contain up to 1000 logs.");

    const logs = inputLogs.map((log) => normalizeLog(match.project.id, log));
    const result = await store.appendLogs(match.project.id, logs);
    sendJson(res, 202, result);
    return;
  }

  throw new AppError(404, "NOT_FOUND", "Endpoint was not found.");
}

async function routeStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) throw new AppError(403, "FORBIDDEN", "Forbidden.");

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    const index = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(index);
  }
}

async function requireUser(req) {
  const token = getBearer(req);
  const payload = verifyJwt(token, store.authSecret);
  if (!payload?.sub) throw new AppError(401, "UNAUTHORIZED", "Authentication is required.");
  const user = await store.findUserById(payload.sub);
  if (!user) throw new AppError(401, "UNAUTHORIZED", "User no longer exists.");
  return user;
}

async function requireRole(req, role) {
  const user = await requireUser(req);
  if (role === "admin" && user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Admin role is required.");
  }
  return user;
}

function getBearer(req) {
  const header = req.headers.authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function safeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

function validate(condition, message) {
  if (!condition) throw new AppError(400, "VALIDATION_ERROR", message);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new AppError(413, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendDownload(res, contentType, filename, body) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error.status || 500;
  const code = error.code || "INTERNAL_ERROR";
  const message = status >= 500 ? "Internal server error." : error.message;
  if (status >= 500) console.error(error);
  sendJson(res, status, { error: { code, message } });
}

function toCsv(rows) {
  const columns = [
    "timestamp",
    "receivedAt",
    "eventId",
    "level",
    "message",
    "category",
    "playerId",
    "sessionId",
    "buildVersion",
    "platform",
    "scene",
    "deviceId",
    "stackTrace",
    "custom"
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(column === "custom" ? JSON.stringify(row.custom || {}) : row[column] || "")).join(","));
  }
  return `\uFEFF${lines.join("\n")}`;
}

function csvCell(value) {
  const text = String(value).replaceAll('"', '""');
  return /[",\n\r]/.test(text) ? `"${text}"` : text;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
