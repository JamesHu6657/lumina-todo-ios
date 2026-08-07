/**
 * cap sync 会重写 ios/App/App/capacitor.config.json 的 packageClassList，
 * 本地 Keychain 插件不在 npm 依赖里，需在每次 sync 后补回。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CFG = path.join(ROOT, "ios", "App", "App", "capacitor.config.json");
const PLUGIN = "LuminaSecureStorePlugin";

function main() {
  if (!fs.existsSync(CFG)) {
    console.warn("post-cap-sync: no", CFG);
    return;
  }
  const json = JSON.parse(fs.readFileSync(CFG, "utf8"));
  const list = Array.isArray(json.packageClassList) ? json.packageClassList.slice() : [];
  if (!list.includes(PLUGIN)) {
    list.push(PLUGIN);
    json.packageClassList = list;
    fs.writeFileSync(CFG, JSON.stringify(json, null, "\t") + "\n", "utf8");
    console.log("post-cap-sync: added", PLUGIN, "to packageClassList");
  } else {
    console.log("post-cap-sync: packageClassList already has", PLUGIN);
  }
}

main();
