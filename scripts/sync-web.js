/**
 * 从桌面 Electron 工程同步前端源码到 iOS www，
 * 再叠 iOS 专用补丁（index / CSS / 桥接脚本）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DESKTOP = path.join(ROOT, "..", "todo-app");
const WWW = path.join(ROOT, "www");

const COPY_FILES = [
  "app.js",
  "chat.js",
  "chat-messages.js",
  "agent-tools.js",
  "agent-loop.js",
  "theme-boot.js",
  "styles.css",
];

const COPY_ASSETS = ["kanna.png", "sakura.png", "cafe.png", "icon.png"];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  console.log("  copy", path.relative(ROOT, to));
}

function main() {
  if (!fs.existsSync(DESKTOP)) {
    console.error("找不到桌面工程：", DESKTOP);
    process.exit(1);
  }
  ensureDir(WWW);
  ensureDir(path.join(WWW, "assets"));
  ensureDir(path.join(WWW, "js"));

  for (const f of COPY_FILES) {
    copyFile(path.join(DESKTOP, f), path.join(WWW, f));
  }
  for (const a of COPY_ASSETS) {
    const src = path.join(DESKTOP, "assets", a);
    if (fs.existsSync(src)) copyFile(src, path.join(WWW, "assets", a));
  }

  // iOS 专用入口 / 样式 / 桥接由本仓库维护，sync 不覆盖
  const localKeep = [
    "index.html",
    "ios.css",
    "js/secure-store.js",
    "js/mobile-bridge.js",
    "js/mobile-clickup.js",
    "js/mobile-notify.js",
    "js/mobile-settings.js",
    "js/mobile-ux.js",
  ];
  for (const rel of localKeep) {
    const p = path.join(WWW, rel);
    if (!fs.existsSync(p)) {
      console.warn("  missing local file (should exist):", rel);
    } else {
      console.log("  keep", rel);
    }
  }

  patchAppForIos();
  console.log("sync-web done →", WWW);
}

/** 从桌面 app.js 同步后，重新注入 iOS 触摸排序桥 */
function patchAppForIos() {
  const appPath = path.join(WWW, "app.js");
  let src = fs.readFileSync(appPath, "utf8");

  if (src.includes("window.__luminaReorder")) {
    console.log("  patch app.js: __luminaReorder already present");
    return;
  }

  const needle = `  window.__luminaAgent = {
    invoke(name, args){ return agentInvoke(name, args); },
    toolLabel(name){ return TOOL_LABELS[name] || name; },
  };
}`;

  const inject = `  window.__luminaAgent = {
    invoke(name, args){ return agentInvoke(name, args); },
    toolLabel(name){ return TOOL_LABELS[name] || name; },
  };
  /* iOS 触摸排序：按 DOM 顺序重排内存 todos 并持久化 */
  window.__luminaReorder = (ids) => {
    if (!Array.isArray(ids) || !ids.length) return false;
    if (typeof sortingEnabled === "function" && !sortingEnabled()) {
      try { toast("清除筛选和搜索后才能排序"); } catch { /* ignore */ }
      return false;
    }
    const map = new Map(todos.map((t) => [t.id, t]));
    const next = [];
    for (const id of ids) {
      const t = map.get(id);
      if (t) { next.push(t); map.delete(id); }
    }
    for (const t of todos) if (map.has(t.id)) next.push(t);
    if (next.length !== todos.length) return false;
    let same = true;
    for (let i = 0; i < next.length; i++) if (next[i].id !== todos[i].id) { same = false; break; }
    if (same) return true;
    snapshot("调整顺序");
    todos = next;
    render(); persist();
    try { play("r-nod"); } catch { /* ignore */ }
    return true;
  };
  if (typeof window.__luminaInstallTouchReorder === "function") {
    try {
      window.__luminaInstallTouchReorder({
        getTodos: () => todos.slice(),
        setTodosAndPersist: (next) => {
          if (!Array.isArray(next)) return false;
          const ids = next.map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean);
          return window.__luminaReorder(ids);
        },
        render,
      });
    } catch { /* ignore */ }
  }
}`;

  if (!src.includes(needle)) {
    throw new Error(
      "patch app.js 失败：installChatBridge 锚点不存在；桌面 app.js 已变更，必须更新 iOS 注入补丁"
    );
  }
  src = src.replace(needle, inject);
  fs.writeFileSync(appPath, src, "utf8");
  console.log("  patch app.js: injected __luminaReorder");
}

main();
