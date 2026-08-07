/** Ensure Capacitor's generated iOS web bundle exactly mirrors canonical www/. */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WWW = path.join(ROOT, "www");
const PUBLIC = path.join(ROOT, "ios", "App", "App", "public");

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

if (!fs.existsSync(PUBLIC)) throw new Error("iOS public bundle is missing; run npm run cap:sync first.");

const mismatches = [];
for (const source of walk(WWW)) {
  const rel = path.relative(WWW, source);
  const generated = path.join(PUBLIC, rel);
  if (!fs.existsSync(generated)) {
    mismatches.push(`${rel}: missing from iOS public`);
    continue;
  }
  const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  const generatedHash = crypto.createHash("sha256").update(fs.readFileSync(generated)).digest("hex");
  if (sourceHash !== generatedHash) mismatches.push(`${rel}: differs from www`);
}

if (mismatches.length) {
  throw new Error(`iOS public bundle is stale:\n${mismatches.map((item) => `- ${item}`).join("\n")}`);
}
console.log("iOS public bundle matches www");
