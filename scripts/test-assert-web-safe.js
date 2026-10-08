/**
 * assert-web-safe 回归：带凭据形状的文件必须让构建失败，干净的包必须放行。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "assert-web-safe.js");

function scan(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-safe-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), body);
    }
    return spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

assert.equal(scan({ "js/app.js": "const ok = 'fake-key-label';\n" }).status, 0, "干净的包应放行");
console.log("✔ 干净的包放行");

for (const [label, secret] of [
  ["OpenCode sk-", "sk-" + "a".repeat(24)],
  ["ClickUp pk_", "pk_" + "1".repeat(24)],
  ["Factory fk-", "fk-" + "Z".repeat(24)],
]) {
  const r = scan({ "js/config.js": `window.KEY = "${secret}";\n` });
  assert.notEqual(r.status, 0, `${label} 必须让构建失败`);
  assert.match(r.stderr, /credential-shaped value detected/);
  console.log(`✔ 拦下 ${label}`);
}
