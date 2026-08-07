/**
 * iOS UX 增强：
 * - 安全区 / 可视高度
 * - 触摸拖拽排序（桌面 HTML5 DnD 在 iOS 上不可用）
 * - 浮动桌宠（手机横条布局时恢复角色）
 * - 键盘弹起时聊天输入可见
 * - 长按行工具
 * - 排序提示文案
 * - 轻触觉（若 Capacitor Haptics 可用）
 */
(() => {
  "use strict";

  const isTouch =
    "ontouchstart" in window ||
    (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);

  document.documentElement.classList.add("is-ios-app");
  if (isTouch) document.documentElement.classList.add("is-touch");

  /* ---- visual viewport / safe area ---- */
  function setVVH() {
    const h = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty("--vvh", `${h}px`);
  }
  setVVH();
  window.addEventListener("resize", setVVH);
  window.visualViewport?.addEventListener("resize", setVVH);
  window.visualViewport?.addEventListener("scroll", setVVH);

  /* ---- haptics (optional Capacitor) ---- */
  async function haptic(style = "light") {
    try {
      const H = window.Capacitor?.Plugins?.Haptics;
      if (!H) return;
      if (style === "success" && H.notification) {
        await H.notification({ type: "SUCCESS" });
      } else if (H.impact) {
        await H.impact({ style: style === "medium" ? "MEDIUM" : "LIGHT" });
      }
    } catch {
      /* ignore */
    }
  }

  /* ---- status sort hint ---- */
  function fixSortHint() {
    const note = document.getElementById("sortNote");
    if (note && isTouch) note.textContent = "长按手柄可排序";
  }

  /* ---- undo title ---- */
  function fixUndoTitle() {
    const undo = document.getElementById("undoBtn");
    if (undo) undo.title = "撤销上一步";
  }

  /* ---- floating desk pet on narrow screens ---- */
  function mountFloatingPet() {
    if (document.getElementById("floatPet")) return;
    const sideChara = document.querySelector(".chara");
    if (!sideChara) return;

    const float = document.createElement("button");
    float.type = "button";
    float.id = "floatPet";
    float.className = "float-pet";
    float.setAttribute("aria-label", "角色搭档");
    float.innerHTML = `
      <div class="float-pet-art" id="floatPetArt"></div>
      <span class="float-pet-bubble" id="floatPetBubble" hidden></span>
    `;
    document.body.appendChild(float);

    // 点击 = 戳侧栏角色（若隐藏则本地说一句）
    float.addEventListener("click", () => {
      const btn = document.getElementById("charaBtn");
      if (btn) btn.click();
      else {
        const b = document.getElementById("floatPetBubble");
        if (b) {
          b.hidden = false;
          b.textContent = "……";
          setTimeout(() => {
            b.hidden = true;
          }, 1600);
        }
      }
      haptic("light");
    });

    // 同步立绘：主题切换 + 抠图后 src 变化（避免 2s 轮询耗电）
    const cssUrl = (u) => `url("${String(u).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
    const syncArt = () => {
      const img = document.getElementById("charaImg");
      const art = document.getElementById("floatPetArt");
      if (!art) return;
      // 抠图后可能是 blob:；没有则退回主题 PNG
      if (img && img.src && !img.src.endsWith("/")) {
        art.style.backgroundImage = cssUrl(img.src);
      } else {
        const theme = document.documentElement.dataset.theme || "kanna";
        art.style.backgroundImage = cssUrl(`./assets/${theme}.png`);
      }
    };
    syncArt();
    const themeMo = new MutationObserver(syncArt);
    themeMo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const img = document.getElementById("charaImg");
    if (img) {
      const imgMo = new MutationObserver(syncArt);
      imgMo.observe(img, { attributes: true, attributeFilter: ["src"] });
      img.addEventListener("load", syncArt);
    }

    // 同步侧栏台词到浮动气泡（#bubbleTxt）
    const bubbleTxt = document.getElementById("bubbleTxt");
    if (bubbleTxt) {
      let hideTimer = null;
      const syncBubble = () => {
        const fb = document.getElementById("floatPetBubble");
        if (!fb) return;
        const text = (bubbleTxt.textContent || "").trim();
        if (!text || text === "……") {
          fb.hidden = true;
          return;
        }
        fb.hidden = false;
        fb.textContent = text.length > 48 ? text.slice(0, 48) + "…" : text;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          fb.hidden = true;
        }, 4200);
      };
      const bmo = new MutationObserver(syncBubble);
      bmo.observe(bubbleTxt, { childList: true, characterData: true, subtree: true });
    }
  }

  /* ---- touch drag sort（长按激活，短点/滚动不重排） ---- */
  function enableTouchSort() {
    if (!isTouch) return;
    const list = document.getElementById("todoList");
    if (!list || list._touchSortBound) return;
    list._touchSortBound = true;

    const HOLD_MS = 320;
    const CANCEL_PX = 10;
    let pending = null;
    let drag = null;

    const clearPending = () => {
      if (!pending) return;
      clearTimeout(pending.timer);
      pending = null;
    };

    list.addEventListener(
      "touchstart",
      (e) => {
        const handle = e.target.closest(".tool.grip, .grip");
        if (!handle) return;
        const row = handle.closest(".row");
        if (!row || !list.contains(row)) return;
        // 历史/筛选不可排序时不开始拖
        if (row.getAttribute("draggable") === "false") return;
        const t = e.touches[0];
        clearPending();
        pending = {
          row,
          x: t.clientX,
          y: t.clientY,
          timer: setTimeout(() => {
            if (!pending || pending.row !== row) return;
            drag = {
              row,
              startY: pending.y,
              id: row.dataset.id || row.getAttribute("data-id"),
            };
            pending = null;
            row.classList.add("dragging", "is-dragging");
            haptic("light");
          }, HOLD_MS),
        };
      },
      { passive: true }
    );

    list.addEventListener(
      "touchmove",
      (e) => {
        const t = e.touches[0];
        if (pending) {
          const moved = Math.hypot(t.clientX - pending.x, t.clientY - pending.y);
          if (moved > CANCEL_PX) clearPending(); // 放行正常滚动
          return;
        }
        if (!drag) return;
        e.preventDefault();
        const y = t.clientY;
        const el = document.elementFromPoint(t.clientX, y);
        const over = el && el.closest ? el.closest(".row") : null;
        if (!over || over === drag.row || !list.contains(over)) return;

        const rect = over.getBoundingClientRect();
        const before = y < rect.top + rect.height / 2;
        if (before) list.insertBefore(drag.row, over);
        else list.insertBefore(drag.row, over.nextSibling);
      },
      { passive: false }
    );

    const end = () => {
      if (pending) {
        clearPending();
        return;
      }
      if (!drag) return;
      const row = drag.row;
      row.classList.remove("dragging", "is-dragging");
      try {
        const ids = [...list.querySelectorAll(".row")]
          .map((r) => r.dataset.id || r.getAttribute("data-id"))
          .filter(Boolean);
        if (typeof window.__luminaReorder === "function") {
          window.__luminaReorder(ids);
        }
      } catch (err) {
        console.warn("[touch-sort]", err);
      }
      drag = null;
      haptic("medium");
    };
    list.addEventListener("touchend", end);
    list.addEventListener("touchcancel", end);
  }

  /**
   * 触摸排序入口：app.js 安装权威的 window.__luminaReorder。
   * 切勿在此处覆盖已存在的 __luminaReorder——旧实现会
   * setTodosAndPersist → __luminaReorder 无限递归，拖拽后整页卡死。
   */
  function patchAppReorder() {
    window.__luminaInstallTouchReorder = function (api) {
      if (api && typeof api === "object") {
        window.__luminaTouchReorderApi = api;
      }
      // app.js 已提供实现时只登记 API，不覆盖
      if (typeof window.__luminaReorder === "function") return;
      // 回退：仅当 app 尚未安装时，用 api 直接改序（next 为 todo 对象数组）
      if (!api || typeof api.getTodos !== "function" || typeof api.setTodosAndPersist !== "function") {
        return;
      }
      window.__luminaReorder = function (ids) {
        if (!Array.isArray(ids) || !ids.length) return false;
        const list = api.getTodos();
        const map = new Map(list.map((t) => [t.id, t]));
        const next = [];
        for (const id of ids) {
          const t = map.get(id);
          if (t) {
            next.push(t);
            map.delete(id);
          }
        }
        for (const t of list) if (map.has(t.id)) next.push(t);
        if (next.length !== list.length) return false;
        api.setTodosAndPersist(next);
        api.render?.();
        haptic("medium");
        return true;
      };
    };
  }

  /* ---- keyboard: keep focused fields above soft keyboard ---- */
  function focusScrollIntoView(el) {
    if (!el || el.disabled) return;
    // 等键盘/visualViewport 稳定后再滚
    const run = () => {
      try {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch {
        el.scrollIntoView(true);
      }
    };
    setTimeout(run, 120);
    setTimeout(run, 320);
  }
  function chatKeyboard() {
    const input = document.getElementById("chatInput");
    if (!input || input._luminaFocusScroll) return;
    input._luminaFocusScroll = true;
    input.addEventListener("focus", () => focusScrollIntoView(input));
  }
  function mainFieldKeyboard() {
    const bind = (el) => {
      if (!el || el._luminaFocusScroll) return;
      el._luminaFocusScroll = true;
      el.addEventListener("focus", () => focusScrollIntoView(el));
    };
    bind(document.getElementById("todoInput"));
    bind(document.getElementById("searchInput"));
    // 行内编辑框是模板克隆，用捕获一次绑定
    if (!document._luminaRowEditFocus) {
      document._luminaRowEditFocus = true;
      document.addEventListener(
        "focusin",
        (e) => {
          const t = e.target;
          if (t && t.classList && t.classList.contains("row-edit")) {
            focusScrollIntoView(t);
          }
        },
        true
      );
    }
  }

  /* ---- list scroll dims floating pet so it never covers text ---- */
  function listScrollPetDim() {
    const scroller = document.getElementById("scroller");
    const root = document.documentElement;
    if (!scroller || scroller._luminaPetDim) return;
    scroller._luminaPetDim = true;
    let timer = null;
    const onScroll = () => {
      root.classList.add("is-list-scrolling");
      clearTimeout(timer);
      timer = setTimeout(() => {
        root.classList.remove("is-list-scrolling");
      }, 420);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---- prevent double-tap zoom on controls ---- */
  function preventDblZoom() {
    let last = 0;
    let lastX = 0;
    let lastY = 0;
    document.addEventListener(
      "touchend",
      (e) => {
        const now = Date.now();
        const touch = e.changedTouches && e.changedTouches[0];
        const x = touch ? touch.clientX : 0;
        const y = touch ? touch.clientY : 0;
        const samePlace = Math.hypot(x - lastX, y - lastY) < 32;
        if (now - last < 300 && samePlace && e.target.closest("button, .row, .nav-item, .check")) {
          e.preventDefault();
        }
        last = now;
        lastX = x;
        lastY = y;
      },
      { passive: false }
    );
  }

  /* ---- Capacitor status bar / app state ----
   * Capacitor StatusBar style: LIGHT = 浅色文字（深色底），DARK = 深色文字（浅色底）
   * kanna 深色主题 → LIGHT；sakura/cafe 浅色主题 → DARK
   */
  async function syncStatusBarTheme() {
    const SB = window.Capacitor?.Plugins?.StatusBar;
    if (!SB?.setStyle) return;
    const theme = document.documentElement.dataset.theme || "kanna";
    await SB.setStyle({ style: theme === "kanna" ? "LIGHT" : "DARK" });
  }

  async function initCapacitor() {
    try {
      const C = window.Capacitor;
      if (!C) return;
      document.documentElement.classList.add("is-capacitor");
      await syncStatusBarTheme();
      new MutationObserver(() => {
        syncStatusBarTheme().catch(() => {});
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      const App = C.Plugins?.App;
      if (App?.addListener) {
        App.addListener("appStateChange", ({ isActive }) => {
          if (isActive) {
            // 回前台刷新番茄显示
            window.dispatchEvent(new Event("lumina:foreground"));
          }
        });
      }
    } catch {
      /* ignore */
    }
  }

  function boot() {
    fixSortHint();
    fixUndoTitle();
    mountFloatingPet();
    enableTouchSort();
    patchAppReorder();
    chatKeyboard();
    mainFieldKeyboard();
    listScrollPetDim();
    preventDblZoom();
    initCapacitor();

    // 列表可能晚渲染，延后绑 touch sort
    const list = document.getElementById("todoList");
    if (list) {
      const mo = new MutationObserver(() => enableTouchSort());
      mo.observe(list, { childList: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
