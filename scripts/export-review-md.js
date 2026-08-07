/**
 * 导出 iOS 源码审查 MD 到用户桌面
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(__dirname, "..");
const desktop = path.join(os.homedir(), "Desktop");
const out = path.join(desktop, "Lumina-Todo-iOS-源码审查.md");

const files = [
  "package.json",
  "capacitor.config.json",
  "README.md",
  "scripts/sync-web.js",
  "scripts/run-bridge-tests.js",
  "www/index.html",
  "www/ios.css",
  "www/js/mobile-bridge.js",
  "www/js/mobile-clickup.js",
  "www/js/mobile-settings.js",
  "www/js/mobile-ux.js",
  "www/theme-boot.js",
  "www/chat-messages.js",
  "www/agent-loop.js",
  "ios/App/App/Info.plist",
  "ios/App/App/AppDelegate.swift",
];

function langOf(rel) {
  if (rel.endsWith(".js")) return "javascript";
  if (rel.endsWith(".html")) return "html";
  if (rel.endsWith(".css")) return "css";
  if (rel.endsWith(".json")) return "json";
  if (rel.endsWith(".swift")) return "swift";
  if (rel.endsWith(".plist")) return "xml";
  if (rel.endsWith(".md")) return "markdown";
  return "text";
}

const parts = [];
parts.push("# Lumina Todo iOS — 源码与审查包");
parts.push("");
parts.push("> 生成时间：2026-08-07");
parts.push("> 工程路径：`D:\\\\FM_dev\\\\workspace\\\\lumina-todo-ios`".replace(/\\\\/g, "\\"));
parts.push("> 桌面版来源：`D:\\FM_dev\\workspace\\todo-app`（Electron win-unpacked）");
parts.push("");
parts.push("---");
parts.push("");
parts.push("## 0. 审查摘要");
parts.push("");
parts.push("### 目标");
parts.push(
  "把 Windows 桌宠 **Lumina Todo** 做成 **iOS App**，保留：待办 / 历史 / 番茄钟 / 三角色 / AI Agent / ClickUp。"
);
parts.push("");
parts.push("### 方案");
parts.push("- **Capacitor 7** 壳 + 原 Web UI");
parts.push("- Electron `main/preload` → `www/js/mobile-bridge.js` + `mobile-clickup.js`");
parts.push("- 密钥：应用内 **设置** 面板（手机无桌面 api.txt）");
parts.push("- 触摸排序 + 浮动桌宠 + 安全区");
parts.push("");
parts.push("### 状态");
parts.push("");
parts.push("| 项 | 状态 |");
parts.push("|---|---|");
parts.push("| 功能代码与桥接 | 已完成 |");
parts.push("| `ios/` Xcode 工程 | 已 `cap add ios` 生成 |");
parts.push("| 桥接冒烟测试 | 9/9 通过 |");
parts.push("| 在 Windows 编译 .ipa | 不可，需 Mac + Xcode + CocoaPods |");
parts.push("| 真机/模拟器实测 | 待在 Mac 上 Run |");
parts.push("");
parts.push("### 已做的修复与体验优化");
parts.push("1. AI 流式 / complete 与桌面 `luminaAI` API 同形，chat.js 无需大改");
parts.push("2. ClickUp token / 离线队列改 localStorage，错误提示指向设置");
parts.push("3. CSP 放行 `https://opencode.ai` 与 `https://api.clickup.com`");
parts.push("4. 触摸按住 `.tool.grip` 排序，调用 `__luminaReorder`（同桌面持久化）");
parts.push("5. 窄屏浮动桌宠：同步 `#charaImg` 与 `#bubbleTxt`");
parts.push("6. 安全区、`viewport-fit=cover`、输入框 16px 防 iOS 聚焦放大");
parts.push("7. 设置面板保存 `sk-` / `pk_` 密钥");
parts.push("8. 桌面显示名「リスト」");
parts.push("");
parts.push("### 已知限制 / 建议后续");
parts.push("1. **系统通知**：iOS WebView 对 Notification 限制大；番茄结束以应用内声音+台词为主。已装 `@capacitor/local-notifications`，可再接到 `finishSegment`");
parts.push("2. **后台计时**：挂起时 tick 停，靠 `endsAt` 墙钟回前台补算（与桌面同思路），需真机验证睡眠场景");
parts.push("3. **密钥在 WebView**：隔离弱于 Electron 主进程；上架敏感可迁 Keychain 原生插件");
parts.push("4. Mac 首次需 `pod install` / `npx cap sync ios`");
parts.push("5. `app.js` 与桌面共用；`sync-web.js` 同步后会重注入 `__luminaReorder`");
parts.push("");
parts.push("### Mac 上构建");
parts.push("");
parts.push("```bash");
parts.push("cd lumina-todo-ios");
parts.push("npm install");
parts.push("npx cap sync ios");
parts.push("npx cap open ios");
parts.push("# Xcode → Signing & Capabilities 选 Team → Run");
parts.push("```");
parts.push("");
parts.push("---");
parts.push("");
parts.push("## 1. 大文件说明（未全文嵌入）");
parts.push("");
parts.push("| 文件 | 约大小 | 说明 |");
parts.push("|---|---|---|");
parts.push("| www/app.js | ~120KB | 待办/番茄/角色 + `__luminaReorder` |");
parts.push("| www/styles.css | ~57KB | 主题引擎与组件 |");
parts.push("| www/chat.js | ~29KB | AI 对话 UI + agent 循环 |");
parts.push("| www/agent-tools.js | ~16KB | 工具 schema |");
parts.push("");
parts.push("完整文件在工程目录。下文为 **iOS 专用与配置全文**。");
parts.push("");
parts.push("---");
parts.push("");

for (const rel of files) {
  const p = path.join(root, rel);
  parts.push(`## 文件：\`${rel}\``);
  parts.push("");
  if (!fs.existsSync(p)) {
    parts.push("_文件缺失_");
    parts.push("");
    continue;
  }
  const body = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").trimEnd();
  parts.push("```" + langOf(rel));
  parts.push(body);
  parts.push("```");
  parts.push("");
}

const app = fs.readFileSync(path.join(root, "www/app.js"), "utf8");
const m = app.match(/window\.__luminaReorder = \(ids\) => \{[\s\S]*?\n  \};/);
parts.push("## 3. app.js 中 iOS 补丁摘录");
parts.push("");
if (m) {
  parts.push("```javascript");
  parts.push(m[0]);
  parts.push("```");
} else {
  parts.push("_请打开 www/app.js 搜索 __luminaReorder_");
}
parts.push("");
parts.push("## 4. 功能对照表");
parts.push("");
parts.push("| 功能 | 桌面 | iOS |");
parts.push("|---|---|---|");
parts.push("| 待办 CRUD / 优先级 / 分类 / 截止日期 | ✅ | ✅ |");
parts.push("| 拖拽排序 | HTML5 DnD | 触摸 grip |");
parts.push("| 撤销 / 导入导出 | ✅ | ✅ |");
parts.push("| 历史视图 | ✅ | ✅ |");
parts.push("| 番茄钟 + 预设 | ✅ | ✅ |");
parts.push("| 角色台词 / 戳一戳 | 侧栏 | 侧栏 + 浮动宠 |");
parts.push("| AI Agent 工具 | main 代理 | mobile-bridge |");
parts.push("| ClickUp 打卡/上传 | 主进程 | mobile-clickup |");
parts.push("| API Key | 桌面 txt / env | 设置面板 |");
parts.push("");
parts.push("---");
parts.push("");
parts.push("*本文件供人工审查。可执行工程：`D:\\FM_dev\\workspace\\lumina-todo-ios`*");
parts.push("");

fs.writeFileSync(out, parts.join("\n"), "utf8");
console.log("Wrote", out);
console.log("Bytes", fs.statSync(out).size);
