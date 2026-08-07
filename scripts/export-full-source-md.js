/**
 * 导出 iOS App 全部文本源码到桌面（多卷 MD + 一份源码树 zip 清单）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(__dirname, "..");
const desktop = path.join(os.homedir(), "Desktop");
const outDir = path.join(desktop, "Lumina-Todo-iOS-完整源码");

const TEXT_EXTS = new Set([
  ".js",
  ".html",
  ".css",
  ".json",
  ".md",
  ".swift",
  ".plist",
  ".xml",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
  ".podspec",
  ".pbxproj",
  ".storyboard",
  ".xcconfig",
  ".gitignore",
  ".npmrc",
]);

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "Pods",
  "build",
  "DerivedData",
  "public", // ios/App/App/public 是 www 副本，避免重复
  ".lumina-local",
]);

const PRIVATE_REL_PATHS = new Set([
  "www/js/personal-config.local.js",
  "www/data/personal-secrets.json",
  "www/data/desktop-state.json",
]);

function langOf(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    ".js": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".swift": "swift",
    ".plist": "xml",
    ".xml": "xml",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".storyboard": "xml",
    ".pbxproj": "text",
    ".podspec": "ruby",
  };
  return map[ext] || "text";
}

function shouldSkipDir(name) {
  return SKIP_DIR.has(name) || name.startsWith(".");
}

/** 收集相对路径文本文件 */
function walk(dir, base = root, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      // 跳过 ios 下复制的 public
      if (ent.name === "public" && dir.replace(/\\/g, "/").includes("/ios/")) continue;
      walk(full, base, acc);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    const isDotfile = ent.name.startsWith(".") && TEXT_EXTS.has(ext === "" ? ".gitignore" : ext);
    const nameOk =
      TEXT_EXTS.has(ext) ||
      ent.name === "Podfile" ||
      ent.name === "LICENSE" ||
      ent.name === ".gitignore";
    if (!nameOk && !isDotfile) continue;
    // 过大 pbxproj 仍收录（工程完整性）
    const rel = path.relative(base, full).replace(/\\/g, "/");
    if (PRIVATE_REL_PATHS.has(rel)) continue;
    acc.push(rel);
  }
  return acc;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fileHeader(rel, size) {
  return [
    "",
    "────────────────────────────────────────",
    `## 文件：\`${rel}\``,
    "",
    `> 大小：${size} bytes`,
    "",
  ].join("\n");
}

function main() {
  ensureDir(outDir);

  const all = walk(root).sort((a, b) => a.localeCompare(b));
  // 优先顺序：配置 → www 业务 → iOS 原生 → 脚本
  const priority = (rel) => {
    if (rel === "package.json" || rel === "capacitor.config.json" || rel === "README.md") return 0;
    if (rel.startsWith("www/js/")) return 1;
    if (rel.startsWith("www/") && !rel.startsWith("www/assets")) return 2;
    if (rel.startsWith("scripts/")) return 3;
    if (rel.startsWith("ios/")) return 4;
    return 5;
  };
  all.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));

  const MAX_PART = 450_000; // 约 450KB 一卷，方便打开
  const parts = [];
  let current = [];
  let currentSize = 0;
  let partIdx = 1;

  const flush = () => {
    if (!current.length) return;
    parts.push({ idx: partIdx, blocks: current });
    partIdx += 1;
    current = [];
    currentSize = 0;
  };

  const indexRows = [];

  for (const rel of all) {
    const abs = path.join(root, rel);
    let body;
    try {
      body = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    } catch (e) {
      body = `/* 读取失败: ${e.message} */\n`;
    }
    const size = Buffer.byteLength(body, "utf8");
    const block =
      fileHeader(rel, size) + "```" + langOf(rel) + "\n" + body.trimEnd() + "\n```\n";
    indexRows.push(`| \`${rel}\` | ${size} | 第 PART 卷 |`);

    if (currentSize + block.length > MAX_PART && current.length) flush();
    current.push({ rel, size, block });
    currentSize += block.length;
  }
  flush();

  // 资产清单（二进制不写正文）
  const assetsDir = path.join(root, "www", "assets");
  const assetLines = [];
  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir)) {
      const p = path.join(assetsDir, name);
      if (!fs.statSync(p).isFile()) continue;
      assetLines.push(`- \`www/assets/${name}\` — ${fs.statSync(p).size} bytes（图片二进制，见工程目录）`);
    }
  }

  // 写总目录
  const toc = [];
  toc.push("# Lumina Todo iOS — 完整源码审查包");
  toc.push("");
  toc.push(`> 生成时间：${new Date().toISOString()}`);
  toc.push(`> 工程：\`D:\\FM_dev\\workspace\\lumina-todo-ios\``);
  toc.push(`> 本目录：\`${outDir}\``);
  toc.push("");
  toc.push("## 说明");
  toc.push("");
  toc.push("这是 **iOS App 的全部文本源码**（含与桌面共用的 `app.js` / `styles.css` / `chat.js` 等）。");
  toc.push("");
  toc.push("- 已排除：`node_modules/`、`ios/**/public/`（www 同步副本）、图片二进制正文");
  toc.push("- 图片资源仍在工程 `www/assets/`，下方有清单");
  toc.push("- 源码按体积拆成多卷 `PART-xx.md`，避免单文件过大打不开");
  toc.push("");
  toc.push("## 卷列表");
  toc.push("");
  for (const p of parts) {
    const n = p.blocks.length;
    const bytes = p.blocks.reduce((s, b) => s + b.size, 0);
    toc.push(`- [PART-${String(p.idx).padStart(2, "0")}.md](./PART-${String(p.idx).padStart(2, "0")}.md) — ${n} 个文件，约 ${bytes} bytes 源码`);
  }
  toc.push("");
  toc.push("## 图片资源（未嵌入正文）");
  toc.push("");
  toc.push(...(assetLines.length ? assetLines : ["_无_"]));
  toc.push("");
  toc.push("## 在 Mac 上编译");
  toc.push("");
  toc.push("```bash");
  toc.push("cd D:/FM_dev/workspace/lumina-todo-ios   # 或拷贝后的路径");
  toc.push("npm install");
  toc.push("npx cap sync ios");
  toc.push("npx cap open ios");
  toc.push("```");
  toc.push("");
  toc.push("## 完整文件索引");
  toc.push("");
  toc.push("| 路径 | 字节 | 所在卷 |");
  toc.push("|---|---:|---|");

  // 回填卷号
  const relToPart = new Map();
  for (const p of parts) {
    for (const b of p.blocks) relToPart.set(b.rel, p.idx);
  }
  for (const rel of all) {
    const abs = path.join(root, rel);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      /* */
    }
    const pi = relToPart.get(rel) || "?";
    toc.push(`| \`${rel}\` | ${size} | PART-${String(pi).padStart(2, "0")} |`);
  }
  toc.push("");
  toc.push("---");
  toc.push("");
  toc.push("下方各 `PART-*.md` 为源码正文。");
  toc.push("");

  fs.writeFileSync(path.join(outDir, "00-目录与说明.md"), toc.join("\n"), "utf8");

  for (const p of parts) {
    const name = `PART-${String(p.idx).padStart(2, "0")}.md`;
    const head = [
      `# Lumina Todo iOS 完整源码 — ${name}`,
      "",
      `> 本卷第 ${p.idx} / ${parts.length} 卷 · 共 ${p.blocks.length} 个文件`,
      `> 返回 [00-目录与说明.md](./00-目录与说明.md)`,
      "",
      "### 本卷文件",
      "",
      ...p.blocks.map((b) => `- \`${b.rel}\` (${b.size} bytes)`),
      "",
      "---",
      "",
    ].join("\n");
    const body = p.blocks.map((b) => b.block).join("\n");
    fs.writeFileSync(path.join(outDir, name), head + body, "utf8");
  }

  // 单文件合并版（给「我就要一个 md」的场景）
  const megaPath = path.join(desktop, "Lumina-Todo-iOS-完整源码-全部合并.md");
  const mega = [
    "# Lumina Todo iOS — 完整源码（单文件合并版）",
    "",
    `> 生成：${new Date().toISOString()}`,
    "> 含全部文本源码。过大时请改用桌面文件夹 `Lumina-Todo-iOS-完整源码/` 分卷阅读。",
    "",
    fs.readFileSync(path.join(outDir, "00-目录与说明.md"), "utf8"),
    "",
  ];
  for (const p of parts) {
    mega.push(`\n\n# ========== ${`PART-${String(p.idx).padStart(2, "0")}`} ==========\n`);
    for (const b of p.blocks) mega.push(b.block);
  }
  fs.writeFileSync(megaPath, mega.join("\n"), "utf8");

  // 也写一份纯源码树到桌面副本（无 node_modules），方便「完整代码」直接打开
  const treeCopy = path.join(desktop, "Lumina-Todo-iOS-源码树");
  copyTree(root, treeCopy);

  console.log("Parts:", parts.length);
  console.log("Files:", all.length);
  console.log("Dir:", outDir);
  console.log("Mega:", megaPath, fs.statSync(megaPath).size);
  console.log("Tree:", treeCopy);
}

function copyTree(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      if (ent.name === "public" && src.replace(/\\/g, "/").includes("/ios")) continue;
      // 跳过 ios 工程里的巨大副本 public
      const from = path.join(src, ent.name);
      const to = path.join(dest, ent.name);
      // 跳过 node_modules 已处理；也跳过 package-lock 可选保留
      copyTree(from, to);
      continue;
    }
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    const rel = path.relative(root, from).replace(/\\/g, "/");
    if (PRIVATE_REL_PATHS.has(rel)) continue;
    // 复制文本 + 图片资源
    const ext = path.extname(ent.name).toLowerCase();
    const allowBin = [".png", ".jpg", ".jpeg", ".ico", ".webp", ".gif"].includes(ext);
    const allowText =
      TEXT_EXTS.has(ext) ||
      ent.name === "Podfile" ||
      ent.name === "package-lock.json" ||
      ent.name === ".gitignore";
    if (!allowText && !allowBin) continue;
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  }
}

main();
