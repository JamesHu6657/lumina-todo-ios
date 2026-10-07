/**
 * iOS 设置面板：API Key + ClickUp token
 * 桌面版读桌面 txt；手机没有桌面文件，所以做应用内配置。
 */
(() => {
  "use strict";

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function toast(msg) {
    const t = document.getElementById("toast");
    const m = document.getElementById("toastMsg");
    if (t && m) {
      m.textContent = msg;
      t.classList.add("show");
      clearTimeout(toast._tm);
      toast._tm = setTimeout(() => t.classList.remove("show"), 2200);
    } else {
      console.log("[settings]", msg);
    }
  }

  const STORAGE_KEY = "lumina-todo-v2";

  /**
   * WKWebView 不处理 <a download> 的 blob 下载（点了没反应却提示「已导出」），
   * 所以 App 内改走系统分享面板（可存到「文件」/AirDrop），不支持时退回剪贴板。
   * 返回 "fallback" 表示非 App 环境，交给网页版原有导出。
   */
  async function exportViaShare() {
    const inApp = !!window.Capacitor?.isNativePlatform?.();
    if (!inApp) return "fallback";
    let todos = [];
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && Array.isArray(saved.todos)) todos = saved.todos;
      else if (Array.isArray(saved)) todos = saved;
    } catch {
      toast("读取本地数据失败");
      return "error";
    }
    const day = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `todo-${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.json`;
    const json = JSON.stringify({ v: 4, exportedAt: day.toISOString(), todos }, null, 2);
    try {
      const file = new File([json], name, { type: "application/json" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        toast(`已导出 ${todos.length} 条`);
        return "ok";
      }
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
    }
    try {
      await navigator.clipboard.writeText(json);
      toast(`已复制 ${todos.length} 条备份到剪贴板`);
      return "ok";
    } catch {
      toast("导出失败：当前系统不支持分享或剪贴板");
      return "error";
    }
  }

  function build() {
    if (document.getElementById("settingsSheet")) return;

    const backdrop = el("div", "settings-backdrop");
    backdrop.id = "settingsBackdrop";
    backdrop.hidden = true;

    const sheet = el("div", "settings-sheet");
    sheet.id = "settingsSheet";
    sheet.hidden = true;
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "应用设置");
    sheet.innerHTML = `
      <header class="settings-head">
        <p class="settings-title">设置</p>
        <button type="button" class="settings-close" id="settingsClose" aria-label="关闭">✕</button>
      </header>
      <div class="settings-body">
        <section class="settings-sec">
          <h3>AI 搭档</h3>
          <p class="settings-hint">密钥只保存在本机，不会上传到其它服务器。</p>
          <label class="settings-label" for="setProvider">服务商</label>
          <select class="settings-input" id="setProvider"></select>
          <p class="settings-hint" id="setProviderHint"></p>
          <label class="settings-label" for="setApiKey" id="setApiKeyLabel">API Key</label>
          <input class="settings-input" id="setApiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" enterkeyhint="done">
          <p class="settings-mask" id="setApiMask"></p>
          <div class="settings-row">
            <button type="button" class="settings-btn" id="setApiSave">保存 AI Key</button>
            <button type="button" class="settings-btn ghost" id="setApiClear">清除</button>
          </div>
        </section>
        <section class="settings-sec">
          <h3>ClickUp</h3>
          <p class="settings-hint">番茄钟打卡与「↑CU」上传。粘贴 <code>pk_</code> 开头的个人 API Token。</p>
          <label class="settings-label" for="setCuToken">ClickUp Token</label>
          <input class="settings-input" id="setCuToken" type="password" autocomplete="off" spellcheck="false" placeholder="pk_…" enterkeyhint="done">
          <p class="settings-mask" id="setCuMask"></p>
          <div class="settings-row">
            <button type="button" class="settings-btn" id="setCuSave">保存 Token</button>
            <button type="button" class="settings-btn ghost" id="setCuClear">清除</button>
          </div>
          <div class="settings-row">
            <button type="button" class="settings-btn ghost" id="setCuClearFailed">清除失败记录</button>
          </div>
        </section>
        <section class="settings-sec">
          <h3>数据</h3>
          <p class="settings-hint">手机顶栏已收拢；备份与导入请在这里操作。</p>
          <div class="settings-row">
            <button type="button" class="settings-btn ghost" id="setExport">导出备份</button>
            <button type="button" class="settings-btn ghost" id="setImport">导入</button>
          </div>
          <div class="settings-row">
            <button type="button" class="settings-btn ghost" id="setClearDone">清除已完成</button>
          </div>
        </section>
        <section class="settings-sec">
          <h3>关于</h3>
          <p class="settings-hint">リスト · Lumina Todo iOS 1.0 · 本地待办 + 角色搭档 + 番茄钟 + AI Agent</p>
        </section>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);

    function open() {
      sheet.hidden = false;
      backdrop.hidden = false;
      document.body.classList.add("settings-open");
      refreshMasks();
    }
    function close() {
      sheet.hidden = true;
      backdrop.hidden = true;
      document.body.classList.remove("settings-open");
    }

    async function refreshMasks() {
      const maskEl = document.getElementById("setApiMask");
      const cuMask = document.getElementById("setCuMask");
      const keyLabel = document.getElementById("setApiKeyLabel");
      const hintEl = document.getElementById("setProviderHint");
      try {
        const pv = await window.luminaAI?.providers?.();
        const cur = pv?.list?.find((x) => x.id === pv.current);
        if (cur) {
          if (keyLabel) keyLabel.textContent = `API Key（${cur.keyHint}）`;
          if (hintEl) hintEl.textContent = `${cur.label} · ${cur.model}`;
        }
      } catch {
        /* ignore */
      }
      try {
        const r = await window.luminaAI?.getApiKeyMask?.();
        if (maskEl) maskEl.textContent = r?.mask ? `已保存：${r.mask}` : "尚未配置";
      } catch (err) {
        if (maskEl) maskEl.textContent = err?.message || "无法读取安全存储";
      }
      try {
        const st = await window.luminaClickUp?.status?.();
        if (cuMask) {
          if (st?.error) {
            cuMask.textContent = st.error;
          } else if (st?.hasToken) {
            const pending = (st.pendingPush || 0) + (st.pendingPomo || 0);
            cuMask.textContent = `已保存 Token · 待同步 ${st.queue || 0}`
              + (pending ? ` · 待核对 ${pending}` : "")
              + (st.failed ? ` · 失败记录 ${st.failed}` : "")
              + (st.queueCorrupt ? " · 队列损坏已保全" : "");
          } else {
            cuMask.textContent = st?.queueCorrupt ? "尚未配置 · 队列损坏已保全" : "尚未配置";
          }
        }
      } catch (err) {
        if (cuMask) cuMask.textContent = err?.message || "无法读取 ClickUp 状态";
      }
    }

    // 服务商下拉：填充并记住当前项
    const providerSel = document.getElementById("setProvider");
    (async () => {
      try {
        const pv = await window.luminaAI?.providers?.();
        if (!pv?.ok || !providerSel) return;
        providerSel.innerHTML = "";
        for (const it of pv.list) {
          const opt = document.createElement("option");
          opt.value = it.id;
          opt.textContent = `${it.label}（${it.model}）`;
          providerSel.appendChild(opt);
        }
        providerSel.value = pv.current;
      } catch {
        /* ignore */
      }
    })();
    providerSel?.addEventListener("change", async () => {
      const id = providerSel.value;
      try {
        const r = await window.luminaAI?.setProvider?.(id);
        if (r?.ok) {
          document.getElementById("setApiKey").value = "";
          toast(`已切换为 ${providerSel.options[providerSel.selectedIndex]?.textContent || id}`);
          refreshMasks();
          document.getElementById("chatRecheck")?.click();
        } else {
          toast(r?.error || "切换失败");
        }
      } catch (err) {
        toast(err?.message || "切换失败");
      }
    });

    document.getElementById("settingsClose").addEventListener("click", close);
    backdrop.addEventListener("click", close);

    document.getElementById("setApiSave").addEventListener("click", async () => {
      const v = document.getElementById("setApiKey").value;
      if (!window.luminaAI?.setApiKey) {
        toast("AI 模块未加载");
        return;
      }
      try {
        const r = await window.luminaAI.setApiKey(v);
        if (r?.ok) {
          document.getElementById("setApiKey").value = "";
          toast("AI Key 已保存");
          refreshMasks();
          document.getElementById("chatRecheck")?.click();
        } else {
          toast(r?.error || "保存失败");
        }
      } catch (err) {
        toast(err?.message || "保存失败");
      }
    });
    document.getElementById("setApiClear").addEventListener("click", async () => {
      let r;
      try {
        r = await window.luminaAI?.setApiKey?.("");
      } catch (err) {
        r = { ok: false, error: err?.message };
      }
      if (r?.ok) {
        document.getElementById("setApiKey").value = "";
        toast("已清除 AI Key");
        document.getElementById("chatRecheck")?.click();
      } else {
        toast(r?.error || "清除失败，密钥可能仍在设备上");
      }
      refreshMasks();
    });

    document.getElementById("setCuSave").addEventListener("click", async () => {
      const v = document.getElementById("setCuToken").value;
      if (!window.luminaClickUp?.setToken) {
        toast("ClickUp 模块未加载");
        return;
      }
      try {
        const r = await window.luminaClickUp.setToken(v);
        if (r?.ok) {
          document.getElementById("setCuToken").value = "";
          toast("ClickUp Token 已保存");
          refreshMasks();
        } else {
          toast(r?.error || "保存失败");
        }
      } catch (err) {
        toast(err?.message || "保存失败");
      }
    });
    document.getElementById("setCuClear").addEventListener("click", async () => {
      let r;
      try {
        r = await window.luminaClickUp?.setToken?.("");
      } catch (err) {
        r = { ok: false, error: err?.message };
      }
      if (r?.ok) {
        document.getElementById("setCuToken").value = "";
        toast("已清除 ClickUp Token");
      } else {
        toast(r?.error || "清除失败，Token 可能仍在设备上");
      }
      refreshMasks();
    });
    document.getElementById("setCuClearFailed")?.addEventListener("click", async () => {
      if (!confirm("清除不可自动重试的 ClickUp 失败记录？")) return;
      try {
        const r = await window.luminaClickUp?.clearFailed?.();
        toast(r?.ok ? "已清除失败记录" : r?.error || "清除失败记录失败");
      } catch (err) {
        toast(err?.message || "清除失败记录失败");
      }
      refreshMasks();
    });

    // 数据：转发到主界面已有按钮（顶栏 foot 在手机上已隐藏以省空间）
    document.getElementById("setExport")?.addEventListener("click", async () => {
      const r = await exportViaShare();
      if (r === "fallback") document.getElementById("exportBtn")?.click();
    });
    document.getElementById("setImport")?.addEventListener("click", () => {
      document.getElementById("importBtn")?.click();
    });
    document.getElementById("setClearDone")?.addEventListener("click", () => {
      close();
      document.getElementById("clearCompleted")?.click();
    });

    // 键盘「完成」键直接保存
    const saveOnEnter = (inputId, btnId) => {
      document.getElementById(inputId)?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        document.getElementById(btnId)?.click();
      });
    };
    saveOnEnter("setApiKey", "setApiSave");
    saveOnEnter("setCuToken", "setCuSave");

    // 工具栏按钮
    const toolbar = document.querySelector(".toolbar .tb-actions") || document.querySelector(".toolbar");
    if (toolbar && !document.getElementById("settingsBtn")) {
      const btn = el("button", "tb-btn icon-only");
      btn.id = "settingsBtn";
      btn.type = "button";
      btn.title = "设置";
      btn.setAttribute("aria-label", "设置");
      // 齿轮（替换原先太阳射线图标）
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z"/>' +
        '<path d="M19.55 12.95v-1.9l-1.9-.38a6.2 6.2 0 0 0-.58-1.4l1.1-1.6-1.35-1.35-1.6 1.1a6.2 6.2 0 0 0-1.4-.58L13 4.45h-2l-.37 1.9a6.2 6.2 0 0 0-1.4.58l-1.6-1.1-1.35 1.35 1.1 1.6a6.2 6.2 0 0 0-.58 1.4l-1.9.37v1.9l1.9.38c.1.5.3.97.58 1.4l-1.1 1.6 1.35 1.35 1.6-1.1c.43.28.9.48 1.4.58l.37 1.9h2l.38-1.9c.5-.1.97-.3 1.4-.58l1.6 1.1 1.35-1.35-1.1-1.6c.28-.43.48-.9.58-1.4l1.9-.38Z"/>' +
        "</svg>";
      btn.addEventListener("click", open);
      // 插到主题按钮前
      const theme = document.getElementById("themeBtn");
      if (theme && theme.parentNode) theme.parentNode.insertBefore(btn, theme);
      else toolbar.appendChild(btn);
    }

    window.LUMINA_SETTINGS = { open, close, refreshMasks };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
