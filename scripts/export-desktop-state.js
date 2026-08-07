/**
 * 从桌面 Electron localStorage（leveldb）+ 桌面 api.txt / clickup.txt
 * 导出个人配置到不参与 Web/iOS 构建的本地私有目录。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const PRIVATE_DIR = path.join(ROOT, ".lumina-local");
const OUT_STATE = path.join(PRIVATE_DIR, "desktop-state.json");
const OUT_TODOS = path.join(PRIVATE_DIR, "desktop-todos.json");
const OUT_SECRETS = path.join(PRIVATE_DIR, "personal-secrets.json");

function findLevelLog() {
  const base = path.join(process.env.APPDATA || "", "lumina-todo", "Local Storage", "leveldb");
  if (!fs.existsSync(base)) return null;
  const logs = fs
    .readdirSync(base)
    .filter((f) => f.endsWith(".log") || /^\d{6}$/.test(f))
    .map((f) => path.join(base, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return logs[0] || null;
}

function findAll(buf, needle) {
  const hits = [];
  let i = 0;
  const n = Buffer.isBuffer(needle) ? needle : Buffer.from(needle);
  while (i < buf.length) {
    const j = buf.indexOf(n, i);
    if (j < 0) break;
    hits.push(j);
    i = j + 1;
  }
  return hits;
}

function extractJsonNear(buf, start, maxLen = 400000) {
  let brace = -1;
  for (let i = start; i < Math.min(buf.length, start + 500); i++) {
    if (buf[i] === 0x7b) {
      brace = i;
      break;
    }
  }
  if (brace < 0) return null;

  const slice = buf.slice(brace, Math.min(buf.length, brace + maxLen));
  // Heuristic: if every other byte is 0 near start, treat as UTF-16LE
  let nulls = 0;
  for (let i = 1; i < Math.min(40, slice.length); i += 2) {
    if (slice[i] === 0) nulls++;
  }
  const asU16 = nulls >= 8;
  const s = asU16 ? slice.toString("utf16le") : slice.toString("utf8");

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    } else if (c === "[") {
      // allow root array for chat history
      depth++;
    } else if (c === "]") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

function extractArrayNear(buf, start, maxLen = 400000) {
  let br = -1;
  for (let i = start; i < Math.min(buf.length, start + 500); i++) {
    if (buf[i] === 0x5b) {
      br = i;
      break;
    }
  }
  if (br < 0) return null;
  const slice = buf.slice(br, Math.min(buf.length, br + maxLen));
  let nulls = 0;
  for (let i = 1; i < Math.min(40, slice.length); i += 2) {
    if (slice[i] === 0) nulls++;
  }
  const s = nulls >= 8 ? slice.toString("utf16le") : slice.toString("utf8");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

function extractLatest(buf, key) {
  const hits = [
    ...findAll(buf, Buffer.from(key, "utf8")).map((h) => ({ h, keyLen: key.length })),
    ...findAll(buf, Buffer.from(key, "utf16le")).map((h) => ({ h, keyLen: key.length * 2 })),
  ].sort((a, b) => a.h - b.h);

  // 标量键：禁止用「后面第一个 {…}」冒充（会误吃到下一条 todo JSON）
  if (key === "lumina-theme") {
    for (const { h, keyLen } of hits.slice().reverse()) {
      const snip = buf.slice(h, h + keyLen + 48).toString("utf8");
      const m = snip.match(/lumina-theme[\x00-\x1f\s.]*?(kanna|sakura|cafe)/);
      if (m) return m[1];
      const snip16 = buf.slice(h, h + keyLen + 96).toString("utf16le");
      const m2 = snip16.match(/lumina-theme[\x00-\x1f\s.]*?(kanna|sakura|cafe)/);
      if (m2) return m2[1];
    }
    return "kanna";
  }
  if (key === "lumina-todo-seeded") {
    for (const { h, keyLen } of hits.slice().reverse()) {
      const snip = buf.slice(h, h + keyLen + 24).toString("utf8");
      if (/\blumina-todo-seeded[\x00-\x1f\s.]*1/.test(snip)) return "1";
    }
    return "1";
  }

  let bestObj = null;
  let bestArr = null;
  for (const { h, keyLen } of hits) {
    const json = extractJsonNear(buf, h + keyLen);
    if (json && (!bestObj || json.length >= bestObj.length)) bestObj = json;
    const arr = extractArrayNear(buf, h + keyLen);
    if (arr && (!bestArr || arr.length >= bestArr.length)) bestArr = arr;
  }
  if (bestObj) {
    try {
      return JSON.parse(bestObj);
    } catch {
      /* fall */
    }
  }
  if (bestArr) {
    try {
      return JSON.parse(bestArr);
    } catch {
      /* fall */
    }
  }
  return null;
}

function readSecretFiles() {
  const home = os.homedir();
  const candidates = {
    apiKey: [
      path.join(home, "Desktop", "api.txt"),
      path.join(home, "OneDrive", "Desktop", "api.txt"),
      process.env.LUMINA_API_KEY_FILE,
      process.env.LUMINA_API_KEY,
    ].filter(Boolean),
    clickupToken: [
      path.join(home, "Desktop", "clickup.txt"),
      path.join(home, "OneDrive", "Desktop", "clickup.txt"),
      process.env.LUMINA_CLICKUP_TOKEN,
    ].filter(Boolean),
  };

  function firstLineFrom(list) {
    for (const item of list) {
      if (item.startsWith("sk-") || item.startsWith("pk_")) return item.trim();
      try {
        if (fs.existsSync(item)) {
          const line = fs.readFileSync(item, "utf8").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
          if (line) return line;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  return {
    apiKey: firstLineFrom(candidates.apiKey),
    clickupToken: firstLineFrom(candidates.clickupToken),
    teamId: process.env.LUMINA_CU_TEAM || "90182801309",
    listId: process.env.LUMINA_CU_LIST || "901818920363",
  };
}

function main() {
  const secrets = readSecretFiles();
  const logPath = findLevelLog();
  const state = {
    exportedAt: new Date().toISOString(),
    source: logPath || null,
  };

  if (logPath) {
    const buf = fs.readFileSync(logPath);
    state["lumina-todo-v2"] = extractLatest(buf, "lumina-todo-v2");
    state["lumina-theme"] = extractLatest(buf, "lumina-theme") || "kanna";
    state["lumina-pomo"] = extractLatest(buf, "lumina-pomo");
    state["lumina-chat-v1"] = extractLatest(buf, "lumina-chat-v1");
    state["lumina-todo-seeded"] = extractLatest(buf, "lumina-todo-seeded") || "1";
  }

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.writeFileSync(OUT_STATE, JSON.stringify(state, null, 2), "utf8");
  const todos = state["lumina-todo-v2"]?.todos;
  fs.writeFileSync(OUT_TODOS, JSON.stringify(Array.isArray(todos) ? todos : [], null, 2), "utf8");

  const secretPayload = {
    apiKey: secrets.apiKey,
    clickupToken: secrets.clickupToken,
    teamId: secrets.teamId,
    listId: secrets.listId,
    importedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT_SECRETS, JSON.stringify(secretPayload, null, 2), "utf8");

  console.log("export-desktop-state:");
  console.log("  leveldb:", logPath || "(not found)");
  console.log("  theme:", state["lumina-theme"]);
  console.log("  todos:", Array.isArray(todos) ? todos.length : 0);
  console.log("  pomo:", state["lumina-pomo"] ? "yes" : "no");
  console.log("  chat:", Array.isArray(state["lumina-chat-v1"]) ? state["lumina-chat-v1"].length : 0);
  console.log("  apiKey:", secrets.apiKey ? "saved in private local backup" : "(missing)");
  console.log("  clickup:", secrets.clickupToken ? "saved in private local backup" : "(missing)");
  console.log("  team/list:", secrets.teamId, secrets.listId);
  console.log("  →", path.relative(ROOT, OUT_STATE));
  console.log("  →", path.relative(ROOT, OUT_TODOS), "(can be selected with the app's import action)");
  console.log("  →", path.relative(ROOT, OUT_SECRETS), "(never copied into www or iOS public)");
}

main();
