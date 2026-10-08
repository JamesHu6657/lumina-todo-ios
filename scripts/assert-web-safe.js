/**
 * Refuse to build or serve a public web bundle containing local credentials
 * or exported private state. This intentionally checks generated iOS public
 * files too when a directory is passed as the first argument.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const target = path.resolve(ROOT, process.argv[2] || "www");
const privateNames = new Set(["personal-config.local.js", "personal-secrets.json", "desktop-state.json"]);
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bpk_[A-Za-z0-9_-]{8,}\b/,
  // Factory API key（中转 VPS 用）：只该在 /etc/factory-relay.env，绝不能进 App 包
  /\bfk-[A-Za-z0-9_-]{8,}\b/,
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

if (!fs.existsSync(target)) throw new Error(`web safety target does not exist: ${target}`);

const violations = [];
for (const file of walk(target)) {
  const rel = path.relative(target, file).replace(/\\/g, "/");
  if (privateNames.has(path.basename(file))) {
    violations.push(`${rel}: private file must not be published`);
    continue;
  }
  const ext = path.extname(file).toLowerCase();
  if (![".js", ".json", ".html", ".css", ".txt", ".md", ".xml", ".plist"].includes(ext)) continue;
  const body = fs.readFileSync(file, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(body))) {
    violations.push(`${rel}: credential-shaped value detected`);
  }
}

if (violations.length) {
  throw new Error(`Unsafe public bundle:\n${violations.map((item) => `- ${item}`).join("\n")}`);
}
console.log(`web safety OK: ${path.relative(ROOT, target) || "."}`);
