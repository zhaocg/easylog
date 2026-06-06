const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

const out = fs.openSync(path.join(dataDir, "server.out.log"), "a");
const err = fs.openSync(path.join(dataDir, "server.err.log"), "a");

const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
  cwd: root,
  detached: true,
  stdio: ["ignore", out, err],
  windowsHide: true
});

child.unref();
console.log(child.pid);
