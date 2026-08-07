/**
 * 首帧主题：必须在 CSS 前同步执行，避免闪白。
 * 拆成独立文件以便 CSP 去掉 script-src 'unsafe-inline'（三轮 C1）。
 *
 * 故意不拉 Google Fonts：Electron 启动时外网 DNS/TLS 很容易把首屏拖慢。
 * 界面用本机字体栈（styles.css --font），离线也稳。
 */
(() => {
  try {
    const t = localStorage.getItem("lumina-theme");
    if (t === "sakura" || t === "kanna" || t === "cafe") {
      document.documentElement.dataset.theme = t;
    }
  } catch {
    /* ignore */
  }
})();
