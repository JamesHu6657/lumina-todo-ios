/**
 * 把完整源码拆成 ClickUp 友好的多个小 MD 包。
 * - 单包 ≤ MAX_PACK_CHARS（默认 20KB 字符）
 * - 大文件按行切段
 * - 输出桌面小包目录 + 每 8 包一批 + zip
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const desktop = path.join(os.homedir(), "Desktop");
const outDir = path.join(desktop, "Lumina-Todo-iOS-ClickUp小包");
const batchDir = path.join(desktop, "Lumina-Todo-iOS-ClickUp-batches");
const MAX_PACK_CHARS = 20_000;
const SKIP_DIR = new Set(["node_modules", ".git", "Pods", "DerivedData", "build", ".lumina-local"]);
const PRIVATE_REL_PATHS = new Set([
  "www/js/personal-config.local.js",
  "www/data/personal-secrets.json",
  "www/data/desktop-state.json",
]);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function langOf(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".js": "javascript",
      ".html": "html",
      ".css": "css",
      ".json": "json",
      ".md": "markdown",
      ".swift": "swift",
      ".plist": "xml",
      ".xml": "xml",
      ".storyboard": "xml",
      ".pbxproj": "text",
      ".podspec": "ruby",
      ".yml": "yaml",
      ".yaml": "yaml",
    }[ext] || "text"
  );
}

function shouldCollect(rel, name) {
  if (PRIVATE_REL_PATHS.has(rel)) return false;
  if (name === "package-lock.json") return false;
  if (rel.includes("ios/App/App/public")) return false;
  if (rel.includes("/public/") && rel.startsWith("ios/")) return false;
  if (rel.startsWith("scripts/export-") && !rel.includes("export-clickup-packs")) return false;
  const ext = path.extname(name).toLowerCase();
  return (
    [
      ".js",
      ".html",
      ".css",
      ".json",
      ".md",
      ".swift",
      ".plist",
      ".xml",
      ".podspec",
      ".pbxproj",
      ".storyboard",
    ].includes(ext) ||
    name === "Podfile" ||
    name === ".gitignore"
  );
}

function walk(dir, base = root, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      if (ent.name === "public" && dir.replace(/\\/g, "/").includes("/ios/")) continue;
      walk(path.join(dir, ent.name), base, acc);
      continue;
    }
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).replace(/\\/g, "/");
    if (!shouldCollect(rel, ent.name)) continue;
    acc.push(rel);
  }
  return acc;
}

function chunkBody(body, maxCodeChars) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let buf = [];
  let bufLen = 0;
  let startLine = 1;

  const flush = (endLine) => {
    if (!buf.length) return;
    chunks.push({ startLine, endLine, text: buf.join("\n") });
    buf = [];
    bufLen = 0;
    startLine = endLine + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const add = line.length + 1;
    if (bufLen + add > maxCodeChars && buf.length) flush(i);
    if (line.length > maxCodeChars) {
      if (buf.length) flush(i);
      for (let o = 0; o < line.length; o += maxCodeChars) {
        chunks.push({
          startLine: i + 1,
          endLine: i + 1,
          text: line.slice(o, o + maxCodeChars),
        });
      }
      startLine = i + 2;
      continue;
    }
    buf.push(line);
    bufLen += add;
  }
  if (buf.length) flush(lines.length);
  return chunks;
}

function packShell(packId, title, body) {
  return [
    `# [${packId}] ${title}`,
    "",
    "> Lumina Todo iOS 源码小包 · ClickUp 分批查看",
    "> 工程：`D:\\FM_dev\\workspace\\lumina-todo-ios`",
    `> 本包：**${packId}** · 总目录：\`00-总目录.md\` / \`00-INDEX.md\``,
    "",
    "---",
    "",
    body.trimEnd(),
    "",
    "---",
    "",
    `*包结束 ${packId} · 请继续下一编号*`,
    "",
  ].join("\n");
}

function safeName(t) {
  return t
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "")
    .slice(0, 48);
}

function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  const files = walk(root).sort((a, b) => {
    const rank = (r) => {
      if (r === "package.json" || r === "capacitor.config.json" || r === "README.md") return 0;
      if (r.startsWith("www/js/")) return 1;
      if (r.startsWith("www/")) return 2;
      if (r.startsWith("scripts/")) return 3;
      if (r.startsWith("ios/")) return 4;
      return 5;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  const maxCode = MAX_PACK_CHARS - 700;
  /** @type {{id:string,title:string,path:string,chars:number}[]} */
  const packs = [];
  let packNum = 1;

  const writePack = (title, section) => {
    const id = "P" + String(packNum).padStart(2, "0");
    const text = packShell(id, title, section);
    const fname = id + "-" + safeName(title) + ".md";
    fs.writeFileSync(path.join(outDir, fname), text, "utf8");
    packs.push({ id, title, path: fname, chars: text.length });
    packNum += 1;
  };

  for (const rel of files) {
    const abs = path.join(root, rel);
    let body;
    try {
      body = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    } catch (e) {
      body = "/* read error: " + e.message + " */";
    }
    const lang = langOf(rel);
    const chunks = chunkBody(body, maxCode);
    const n = chunks.length;
    chunks.forEach((ch, i) => {
      const part =
        n > 1 ? " (" + (i + 1) + "/" + n + " L" + ch.startLine + "-" + ch.endLine + ")" : "";
      const title = rel + part;
      const section = [
        "## `" + rel + "`" + part,
        "",
        n > 1
          ? "> 分段 **" + (i + 1) + "/" + n + "** · 源文件行 **" + ch.startLine + "–" + ch.endLine + "**"
          : "> 完整文件 · " + Buffer.byteLength(body, "utf8") + " bytes",
        "",
        "```" + lang,
        ch.text.trimEnd(),
        "```",
      ].join("\n");
      writePack(title, section);
    });
  }

  // 资源清单
  const assetLines = ["## 图片资源清单（二进制不进 MD）", ""];
  const assetsDir = path.join(root, "www", "assets");
  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir)) {
      const p = path.join(assetsDir, name);
      if (!fs.statSync(p).isFile()) continue;
      assetLines.push("- `www/assets/" + name + "` — " + fs.statSync(p).size + " bytes");
    }
  }
  assetLines.push("", "## 构建", "", "```bash", "cd lumina-todo-ios", "npm install", "npx cap sync ios", "npx cap open ios", "```");
  writePack("assets-and-build", assetLines.join("\n"));

  const total = packs.length;

  // 总目录
  const toc = [];
  toc.push("# Lumina Todo iOS — ClickUp 小包总目录");
  toc.push("");
  toc.push("> 生成：" + new Date().toISOString());
  toc.push("> 共 **" + total + "** 个小包 · 单包约 ≤ " + MAX_PACK_CHARS + " 字符");
  toc.push("> 目录：`" + outDir + "`");
  toc.push("");
  toc.push("## ClickUp 用法");
  toc.push("");
  toc.push("1. 先贴 **00-INDEX.md**（或 00-总目录.md）");
  toc.push("2. 按 **P01 → P" + String(total).padStart(2, "0") + "** 依次上传（每条评论/附件 1 个小包）");
  toc.push("3. 或按 **Batch-01…** 分组文件夹分批传");
  toc.push("4. 大文件标题带 `(1/N Lx-y)` 表示分段");
  toc.push("");
  toc.push("## 小包列表");
  toc.push("");
  toc.push("| 编号 | 文件 | 内容 | 字符 |");
  toc.push("|---|---|---|---:|");
  for (const p of packs) {
    toc.push("| **" + p.id + "** | `" + p.path + "` | " + p.title.replace(/\|/g, "/") + " | " + p.chars + " |");
  }
  toc.push("");
  toc.push("## 按源文件反查");
  toc.push("");
  const byFile = new Map();
  for (const p of packs) {
    const key = p.title.split(" (")[0];
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(p.id);
  }
  toc.push("| 源文件 | 小包 |");
  toc.push("|---|---|");
  for (const [f, ids] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    toc.push("| `" + f + "` | " + ids.join(", ") + " |");
  }
  toc.push("");
  toc.push("工程：`D:\\FM_dev\\workspace\\lumina-todo-ios`");
  toc.push("");

  const tocText = toc.join("\n");
  fs.writeFileSync(path.join(outDir, "00-总目录.md"), tocText, "utf8");
  fs.writeFileSync(path.join(outDir, "00-INDEX.md"), tocText, "utf8");

  // batches
  fs.rmSync(batchDir, { recursive: true, force: true });
  ensureDir(batchDir);
  fs.copyFileSync(path.join(outDir, "00-INDEX.md"), path.join(batchDir, "00-INDEX.md"));
  const batchSize = 8;
  const batchCount = Math.ceil(packs.length / batchSize);
  for (let i = 0; i < packs.length; i += batchSize) {
    const batchNo = Math.floor(i / batchSize) + 1;
    const bdir = path.join(batchDir, "Batch-" + String(batchNo).padStart(2, "0"));
    ensureDir(bdir);
    const slice = packs.slice(i, i + batchSize);
    for (const p of slice) {
      fs.copyFileSync(path.join(outDir, p.path), path.join(bdir, p.path));
    }
    fs.writeFileSync(
      path.join(bdir, "README.md"),
      [
        "# Batch " + String(batchNo).padStart(2, "0") + " / " + batchCount,
        "",
        "Packs " + slice[0].id + " – " + slice[slice.length - 1].id,
        "",
        ...slice.map((p) => "- " + p.id + ": " + p.path),
        "",
      ].join("\n"),
      "utf8"
    );
  }

  // zip via ps1
  const zipPacks = path.join(desktop, "Lumina-Todo-iOS-ClickUp-packs.zip");
  const zipBatches = path.join(desktop, "Lumina-Todo-iOS-ClickUp-batches.zip");
  const ps1 = path.join(desktop, "_lumina_zip_clickup.ps1");
  const esc = (s) => String(s).replace(/'/g, "''");
  fs.writeFileSync(
    ps1,
    [
      "$ErrorActionPreference = 'Stop'",
      "if (Test-Path -LiteralPath '" + esc(zipPacks) + "') { Remove-Item -LiteralPath '" + esc(zipPacks) + "' -Force }",
      "if (Test-Path -LiteralPath '" + esc(zipBatches) + "') { Remove-Item -LiteralPath '" + esc(zipBatches) + "' -Force }",
      "Compress-Archive -LiteralPath '" + esc(outDir) + "' -DestinationPath '" + esc(zipPacks) + "' -Force",
      "Compress-Archive -LiteralPath '" + esc(batchDir) + "' -DestinationPath '" + esc(zipBatches) + "' -Force",
      "Write-Host 'zip-ok'",
      "Get-Item -LiteralPath '" + esc(zipPacks) + "','" + esc(zipBatches) + "' | Format-Table Name,Length",
    ].join("\r\n"),
    "utf8"
  );
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
      stdio: "inherit",
    });
  } catch (e) {
    console.warn("zip failed:", e.message);
  }
  try {
    fs.unlinkSync(ps1);
  } catch {
    /* ignore */
  }

  const sizes = packs.map((p) => p.chars);
  console.log(
    JSON.stringify(
      {
        outDir,
        batchDir,
        packCount: total,
        batchCount,
        maxChars: Math.max(...sizes),
        minChars: Math.min(...sizes),
        avgChars: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
        zipPacks: fs.existsSync(zipPacks) ? zipPacks : null,
        zipBatches: fs.existsSync(zipBatches) ? zipBatches : null,
      },
      null,
      2
    )
  );
}

main();
