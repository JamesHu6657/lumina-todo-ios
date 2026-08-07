/**
 * iOS 原生本地通知：番茄段结束时即使 WebView 在后台也能提醒。
 * 依赖 @capacitor/local-notifications；浏览器环境 no-op。
 *
 * 与 app.js 约定：
 * - window.__luminaOnPomoChange(pomoSnapshot)
 * - window.__luminaNotifyNow(title, body)
 * - window.__luminaRequestNotifyPermission()
 */
(() => {
  "use strict";

  const ID_FOCUS = 91001;
  const ID_REST = 91002;
  const ALL_IDS = [{ id: ID_FOCUS }, { id: ID_REST }];

  let ready = false;
  let perm = "prompt"; // prompt | granted | denied
  let lastScheduleKey = "";
  let lastSnapshot = null;
  // App 的开始/暂停/重置可连续触发；串行化原生调用以免旧 schedule 覆盖新 cancel。
  let pomoChanges = Promise.resolve();

  function plugin() {
    try {
      return window.Capacitor?.Plugins?.LocalNotifications || null;
    } catch {
      return null;
    }
  }

  async function ensureReady(force = false) {
    const LN = plugin();
    if (!LN) return false;
    if (ready && !force) return true;
    try {
      if (LN.checkPermissions) {
        const st = await LN.checkPermissions();
        perm = st?.display || st?.localNotifications || "prompt";
      }
      ready = true;
      return true;
    } catch {
      return false;
    }
  }

  async function requestPermission() {
    const LN = plugin();
    if (!LN?.requestPermissions) {
      // 浏览器 Web Notification
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          await Notification.requestPermission();
        }
      } catch {
        /* ignore */
      }
      return typeof Notification !== "undefined" && Notification.permission === "granted";
    }
    await ensureReady();
    try {
      const st = await LN.requestPermissions();
      perm = st?.display || st?.localNotifications || perm;
      return perm === "granted";
    } catch {
      return false;
    }
  }

  async function cancelAll() {
    const LN = plugin();
    if (!LN?.cancel) return;
    try {
      await LN.cancel({ notifications: ALL_IDS });
    } catch {
      /* ignore */
    }
    lastScheduleKey = "";
  }

  function modeLabel(mode) {
    if (mode === "focus") return { id: ID_FOCUS, title: "专注结束", body: "该休息了。" };
    if (mode === "long") return { id: ID_REST, title: "长憩结束", body: "可以继续了。" };
    return { id: ID_REST, title: "休息结束", body: "可以继续了。" };
  }

  /**
   * 根据番茄快照调度/取消。
   * snapshot: { running, sound, mode, endsAt }
   */
  async function applyPomoChange(snap, { refreshPermission = false } = {}) {
    if (!snap || typeof snap !== "object") return;
    lastSnapshot = { ...snap };
    const LN = plugin();
    if (!LN?.schedule) return;

    await ensureReady(refreshPermission);

    if (!snap.sound || !snap.running || !Number.isFinite(snap.endsAt) || snap.endsAt <= Date.now() + 800) {
      await cancelAll();
      return;
    }

    if (perm !== "granted") {
      // 不在后台静默强弹权限；有用户手势路径（铃铛）会 request
      await cancelAll();
      return;
    }

    const meta = modeLabel(snap.mode);
    const at = new Date(snap.endsAt);
    const key = `${meta.id}:${snap.endsAt}`;
    if (key === lastScheduleKey) return;

    try {
      await LN.cancel({ notifications: ALL_IDS });
      await LN.schedule({
        notifications: [
          {
            id: meta.id,
            title: meta.title,
            body: meta.body,
            schedule: { at, allowWhileIdle: true },
            sound: undefined,
            extra: { kind: "pomo", mode: snap.mode },
          },
        ],
      });
      lastScheduleKey = key;
    } catch (err) {
      console.warn("[mobile-notify] schedule failed", err);
    }
  }

  async function notifyNow(title, body) {
    const LN = plugin();
    if (LN?.schedule && perm === "granted") {
      try {
        // 立即通知：用近未来 1s，避免部分系统忽略 past dates
        const at = new Date(Date.now() + 1000);
        const id = 91009;
        await LN.schedule({
          notifications: [
            {
              id,
              title: String(title || "リスト"),
              body: String(body || ""),
              schedule: { at, allowWhileIdle: true },
              extra: { kind: "pomo-now" },
            },
          ],
        });
        return;
      } catch {
        /* fall through web */
      }
    }
    try {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      if (!document.hidden) return;
      new Notification(String(title || "リスト"), { body: String(body || ""), silent: true });
    } catch {
      /* ignore */
    }
  }

  window.__luminaOnPomoChange = (snap) => {
    const snapshot = snap && typeof snap === "object" ? { ...snap } : snap;
    pomoChanges = pomoChanges
      .catch(() => {})
      .then(() => applyPomoChange(snapshot));
    pomoChanges.catch(() => {});
  };
  window.__luminaNotifyNow = (title, body) => {
    notifyNow(title, body).catch(() => {});
  };
  window.__luminaRequestNotifyPermission = () => requestPermission();
  window.addEventListener("lumina:foreground", () => {
    // 用户可能刚从系统设置里改了通知权限；刷新后必须按最后一次
    // 番茄状态重新 schedule，而不只是更新内存里的权限标记。
    pomoChanges = pomoChanges
      .catch(() => {})
      .then(() => lastSnapshot ? applyPomoChange(lastSnapshot, { refreshPermission: true }) : ensureReady(true));
    pomoChanges.catch(() => {});
  });

  // 冷启动：检查权限
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureReady().catch(() => {});
    });
  } else {
    ensureReady().catch(() => {});
  }
})();
