# リスト · Lumina Todo（iOS）

从 Windows 桌宠 `todo-app`（Electron）移植的 **iOS App**。  
**保留全部功能**：待办、历史、番茄钟、三角色主题、AI Agent 工具循环、ClickUp 打卡/上传。

## 架构

| 桌面 Electron | iOS |
|---|---|
| `main.js` + `preload.js` AI 代理 | `www/js/mobile-bridge.js`（WebView 内 fetch） |
| `clickup-time.js`（主进程） | `www/js/mobile-clickup.js` |
| 桌面 `api.txt` / `clickup.txt` | 应用内 **设置**；真机走 **Keychain**（`LuminaSecureStore`） |
| HTML5 拖拽排序 | 触摸按住 **手柄** 排序 |
| 侧栏立绘 | 窄屏 **浮动桌宠**（右下角可戳） |

技术栈：**Capacitor 7** + 现有 Web UI（`app.js` / `chat.js` / …）。

## 功能清单（对齐桌面）

- 待办：优先级 / 分类 / 截止日期 / 排序 / 就地编辑 / 撤销
- 历史：近 7 天 / 30 天 / 全部
- 番茄钟：三档预设、长短休息、绑定任务、提示音
- 角色搭档：栞那 / 小樱 / 店员 · 台词与动作
- AI：OpenCode Go · DeepSeek V4 Flash · Agent 工具（加改删待办、番茄、主题…）
- ClickUp：专注结束打卡、↑CU 上传 My Work、离线队列、operationId 幂等
- 后台提醒：Capacitor Local Notifications（开铃铛并授权后，到点推送）

## 在 Mac 上打出 iOS App

> 本机是 Windows 时**无法**编译 `.ipa` / 在模拟器运行。请把本目录拷到 Mac。

### 前置

- macOS + Xcode 15+
- Node 20+
- Apple ID（真机调试 / 上架再配证书）

### 步骤

```bash
cd lumina-todo-ios
npm install
npm run ios:prepare       # 从 ../todo-app 同步并安全校验，再同步 iOS
npx cap open ios          # 打开 Xcode
```

在 Xcode：

1. **Signing & Capabilities** 选你的 Team  
2. 目标设备选模拟器或真机  
3. Run（▶）

可选打包：Product → Archive → Distribute App。

### 浏览器预览（无原生壳）

```bash
npm run serve
# 打开 http://localhost:5173
```

在设置里填 API Key 后可测 AI；ClickUp 同理。

## 配置密钥与桌面数据

桌面版读的是 `Desktop/api.txt`、`Desktop/clickup.txt` 和 Electron 本地清单。可在 Windows 上生成一份**不参与构建**的本地备份：

```bash
npm run import-config
```

会生成（已在 `.gitignore`，勿提交）：

- `.lumina-local/personal-secrets.json` — API / ClickUp 密钥私有备份  
- `.lumina-local/desktop-state.json` — 完整桌面状态私有备份  
- `.lumina-local/desktop-todos.json` — 可通过 App 的「导入」选择的待办文件  

密钥**绝不**自动注入 `www/`、浏览器预览或 iOS 包。请在 App 的 **⚙ 设置** 中手动粘贴；真机将保存到 Keychain。若需迁移待办，将 `desktop-todos.json` 通过 Files/AirDrop 传到 iPhone 后，用 App 的导入动作选择它。

ClickUp Team / List 默认与桌面相同：`90182801309` / `901818920363`。

也可手动在 **⚙ 设置** 里粘贴：

1. **API Key**：`sk-…`  
2. **ClickUp Token**：`pk-…`

## 目录

```
lumina-todo-ios/
  capacitor.config.json
  package.json
  README.md
  scripts/
    sync-web.js           # 从桌面工程同步 + 注入 iOS 补丁
    assert-web-safe.js    # 阻止密钥或私有状态进入公开 bundle
    verify-ios-public.js  # 验证 iOS public 与 www 完全一致
    run-bridge-tests.js
  resources/icon.png
  www/                    # Capacitor webDir
    index.html            # iOS CSP + 脚本顺序
    ios.css
    app.js / chat.js / …  # 与桌面同源逻辑
    js/
      mobile-bridge.js    # luminaAI
      mobile-clickup.js
      mobile-settings.js
      mobile-ux.js        # 触控 / 桌宠 / 安全区
    assets/*.png
  ios/                    # 在 Mac 上 `cap add ios` 后生成
```

## 与桌面版差异（有意）

1. **密钥入口**：手机无桌面文件 → 设置面板  
2. **通知**：Web Notification 在 iOS 受限；番茄结束以应用内台词 + 提示音为主（可再接 Local Notifications 插件）  
3. **拖拽**：触摸手柄排序  
4. **桌宠**：窄屏浮动立绘，避免挤占列表  
5. **CSP**：放行 `opencode.ai` 与 `api.clickup.com`

## 测试

```bash
npm test
```

## 版本

- App：1.0.0  
- 同步自桌面 `todo-app` 功能基线
