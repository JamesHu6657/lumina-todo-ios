/**
 * ClickUp 桥（浏览器 / iOS WebView 版）
 * - token 优先 Keychain（LuminaSecureStore），回退 localStorage
 * - 队列落 localStorage；创建任务/时间记录带 [lumina-op:…] 幂等标记
 * - flush 单飞；超时先查询再决定是否重试
 * - 结果不确定的提交只做 marker 对账，不自动重建/补发；长时间未确认交给用户手动重试
 * - 同一待办的上传：同页 single-flight + 跨页 Web Lock；没有可靠跨页锁时不自动提交
 * - 共享集合（队列/待核对/已创建/失败记录）的读-改-写都在同一把全局 "store" 锁内完成
 */
(function (root) {
  "use strict";

  const API = "https://api.clickup.com/api/v2";
  /** 可由不含密钥的 LUMINA_CLICKUP_IDS 覆盖。 */
  function teamId() {
    const ext = root.LUMINA_CLICKUP_IDS || {};
    return (
      (typeof ext.teamId === "string" && ext.teamId) ||
      (typeof ext.TEAM_ID === "string" && ext.TEAM_ID) ||
      "90182801309"
    );
  }
  function listId() {
    const ext = root.LUMINA_CLICKUP_IDS || {};
    return (
      (typeof ext.listId === "string" && ext.listId) ||
      (typeof ext.LIST_ID === "string" && ext.LIST_ID) ||
      "901818920363"
    );
  }
  const QUEUE_KEY = "lumina-cu-queue-v1";
  const FAILED_QUEUE_KEY = "lumina-cu-failed-v1";
  const TOKEN_KEY = "lumina-cu-token";
  const PENDING_PUSH_KEY = "lumina-cu-pending-push-v1";
  const PENDING_POMO_KEY = "lumina-cu-pending-pomo-v1";
  const PUSHED_KEY = "lumina-cu-pushed-v1";
  const CORRUPT_QUEUE_KEY = "lumina-cu-queue-corrupt-v1";
  // 番茄打卡时按标题新建任务的「不确定」记录（审查四⑦）：结果未知的建任务 POST 只对账、不重发
  const PENDING_TASK_KEY = "lumina-cu-pending-task-v1";
  // 审查五 C：番茄打卡的独立完成回执（按 operationId），成功/无队列项/队列项移除都不清，只按 TTL/容量过期
  const POMO_DONE_KEY = "lumina-cu-pomo-done-v1";
  // 审查五 D：按标题建/找到的任务 id（账号 + 清单 + 规范化标题），跨页可见，免得另一页再建一个同名任务
  const TASK_MAP_KEY = "lumina-cu-task-map-v1";
  const MAX_POMO_DONE = 500;
  const MAX_TASK_MAP = 200;
  // 容量上限只用来拒绝新增，绝不淘汰未确认的旧记录
  const MAX_QUEUE = 200;
  const MAX_FAILED = 200;
  const MAX_PENDING = 50;
  const MAX_PUSHED = 500;
  const MAX_TRIES = 5;
  const MAX_LIST_PAGES = 5;
  const OP_RE = /\[lumina-op:([A-Za-z0-9._:-]{6,80})\]/;

  const LIMITS = {
    tokenCacheMs: 5 * 60 * 1000,
    taskCacheMs: 10 * 60 * 1000,
    requestTimeoutMs: 15000,
    // 番茄打卡与上传待办共用同一条标题规范：长度不同会让番茄按名称找不到已上传的任务
    maxTaskTitleChars: 500,
    minTokenChars: 20,
    maxMinutes: 180,
    maxResponseChars: 512 * 1024,
    endedAtSkewMs: 60 * 1000,
    // 超时后服务端可能稍晚才落库。宽限期只决定「多久后提示用户手动处理」：
    // 宽限期过后一次空查询也不能证明原请求不会再提交，绝不自动重建/补发
    pendingRequeueGraceMs: 10 * 60 * 1000,
    // 完成回执保留 7 天：远远长于 ClickUp 查询的可见延迟，过期后仍有远端 marker 预查兜底
    pomoDoneTtlMs: 7 * 24 * 60 * 60 * 1000,
    // 标题→任务 id 映射保留 7 天：远端删任务时 404 会主动作废
    taskMapTtlMs: 7 * 24 * 60 * 60 * 1000,
  };

  let tokenCache = { value: null, at: 0 };
  // 身份缓存按 token 隔离：换账号后绝不能沿用旧账号的 assignee
  let userIdCache = { value: null, at: 0, token: null };
  // 每次保存/清除 token 递增；迁移等异步读取回来时代际不符就不许覆盖缓存
  let tokenGeneration = 0;
  const taskCache = new Map();
  const ensureInflight = new Map();
  // 同页 single-flight：同一 operationId 的上传共享一次「查询→创建→落盘」
  const pushInflight = new Map();
  let flushPromise = null;
  let tokenReady = null;

  /* ----------------------------- 互斥 ----------------------------- */
  /**
   * 跨页面原子互斥：优先 Web Locks（navigator.locks，iOS WKWebView 15.4+ 支持）。
   * 锁由浏览器在所有同源页面间仲裁，持有页崩溃/关闭时自动释放。
   *
   * 审查四④：没有可靠跨页锁时绝不退回 localStorage 租约（写后回读不是原子操作，两页仍可能同时 POST）。
   *   - iOS App（Capacitor 原生壳）只有一个 WKWebView / 一个 JS 上下文，不存在第二个页面，
   *     本页 FIFO 互斥就是完整互斥（iOS 14–15.3 没有 Web Locks 时靠这一条）；
   *   - 其它环境（老浏览器、锁服务抛 SecurityError）一律失败关闭：不自动提交，
   *     返回可重试的 LOCK_UNAVAILABLE，记录原样保留。
   */
  function lockManager() {
    try {
      const lm = root.navigator && root.navigator.locks;
      return lm && typeof lm.request === "function" ? lm : null;
    } catch {
      return null;
    }
  }
  /** 原生壳里的唯一 WebView：本页互斥即全局互斥 */
  function singleWebView() {
    try {
      return Boolean(root.Capacitor && typeof root.Capacitor.isNativePlatform === "function" && root.Capacitor.isNativePlatform());
    } catch {
      return false;
    }
  }
  function lockUnavailableError() {
    const err = new Error("当前环境没有可靠的跨页面锁，为避免重复提交已暂停自动提交，记录已保留");
    err.code = "LOCK_UNAVAILABLE";
    err.lockUnavailable = true;
    err.retryable = true;
    return err;
  }
  function isLockUnavailable(err) {
    return Boolean(err && err.lockUnavailable);
  }
  const LOCK_PREFIX = "lumina-clickup:";
  const pageLockTails = new Map();
  /**
   * 排队等待的互斥（本页 FIFO + 跨页 Web Lock）。fn 内绝不能再请求同名锁。
   * 拿不到可靠的跨页锁时 reject LOCK_UNAVAILABLE，fn 不会执行。
   */
  function withLock(name, fn) {
    const prev = pageLockTails.get(name) || Promise.resolve();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const tail = prev.then(() => gate);
    pageLockTails.set(name, tail);
    return prev.then(async () => {
      try {
        const lm = lockManager();
        if (lm) {
          let entered = false;
          try {
            return await lm.request(LOCK_PREFIX + name, { mode: "exclusive" }, () => {
              entered = true;
              return fn();
            });
          } catch (err) {
            if (entered) throw err;
            // 锁服务本身不可用（SecurityError 等，回调从未进入）
            if (singleWebView()) return await fn();
            throw lockUnavailableError();
          }
        }
        if (singleWebView()) return await fn();
        throw lockUnavailableError();
      } finally {
        release();
        if (pageLockTails.get(name) === tail) pageLockTails.delete(name);
      }
    });
  }
  /**
   * 不等待的互斥：锁被（任一页面）占用时立即调用 onBusy；
   * 没有可靠跨页锁时调用 onUnavailable（默认 reject LOCK_UNAVAILABLE），fn 不执行。
   */
  async function withLockIfAvailable(name, fn, onBusy, onUnavailable) {
    const unavailable = () => {
      if (onUnavailable) return onUnavailable();
      throw lockUnavailableError();
    };
    const lm = lockManager();
    if (!lm) return singleWebView() ? fn(false) : unavailable();
    let entered = false;
    try {
      return await lm.request(LOCK_PREFIX + name, { mode: "exclusive", ifAvailable: true }, (lock) => {
        entered = true;
        return lock ? fn(true) : onBusy();
      });
    } catch (err) {
      if (entered) throw err;
      return singleWebView() ? fn(false) : unavailable();
    }
  }
  /**
   * 审查四⑤：共享集合的读-改-写放进同一把全局 "store" 锁。mutator 必须是同步函数
   * （锁内不 await、不再请求任何锁），所以它总是最内层的锁，不会死锁。
   * 拿不到锁时返回 fallback（默认 false = 写失败），调用方按写失败处理。
   */
  async function mutateStore(mutator, fallback = false) {
    try {
      return await withLock("store", () => mutator());
    } catch (err) {
      if (isLockUnavailable(err)) return fallback;
      throw err;
    }
  }

  function secure() {
    return root.LUMINA_SECURE_STORE || null;
  }
  function usesKeychain() {
    return secure()?.backend?.() === "keychain";
  }

  function newId(prefix) {
    try {
      if (globalThis.crypto?.randomUUID) return (prefix || "") + globalThis.crypto.randomUUID();
    } catch {
      /* fall through */
    }
    return (
      (prefix || "") +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function newQueueId() {
    return newId("q-");
  }

  function newOpId(hint) {
    if (typeof hint === "string" && /^[A-Za-z0-9._:-]{6,80}$/.test(hint)) return hint;
    return newId("op-");
  }

  /** Convert any imported/local todo id into a deterministic, marker-safe id. */
  function stableTodoOperationId(todoId) {
    const raw = String(todoId || "");
    const direct = "todo-" + raw;
    if (/^[A-Za-z0-9._:-]{6,80}$/.test(direct)) return direct;
    // Two independent 32-bit hashes keep non-ASCII imported IDs stable without
    // putting user text into ClickUp descriptions or exceeding the marker limit.
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ (c + i), 0x85ebca6b);
    }
    return `todo-h${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}-${raw.length.toString(36)}`;
  }

  function opMarker(operationId) {
    return "[lumina-op:" + operationId + "]";
  }

  function extractOpId(text) {
    const m = String(text || "").match(OP_RE);
    return m ? m[1] : null;
  }

  function redactSecrets(text) {
    return String(text || "").replace(/pk_[A-Za-z0-9_-]{8,}/g, (m) => m.slice(0, 6) + "***");
  }

  function isValidToken(line) {
    return typeof line === "string" && line.startsWith("pk_") && line.length >= LIMITS.minTokenChars;
  }

  function storeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function storeSet(key, val) {
    try {
      localStorage.setItem(key, val);
      return true;
    } catch {
      return false;
    }
  }
  function storeRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  async function ensureTokenMigrated() {
    if (tokenReady) return tokenReady;
    const gen = tokenGeneration;
    // 迁移期间用户保存/清除了 token：以用户的新操作为准，迁移结果作废
    const adopt = (value) => {
      if (gen !== tokenGeneration) return tokenCache.value;
      tokenCache = { value, at: Date.now() };
      return value;
    };
    const p = (async () => {
      const s = secure();
      if (s?.migrateKey) {
        const v = await s.migrateKey(TOKEN_KEY);
        if (isValidToken(v)) return adopt(v);
        if (usesKeychain()) return adopt(null);
      }
      const raw = (storeGet(TOKEN_KEY) || "").trim();
      return adopt(isValidToken(raw) ? raw : null);
    })();
    tokenReady = p;
    try {
      return await p;
    } catch (err) {
      // 失败后允许下次重试（成功路径保留 promise 合并并发）
      if (tokenReady === p) tokenReady = null;
      throw err;
    }
  }

  async function getStoredToken() {
    await ensureTokenMigrated();
    if (tokenCache.value && isValidToken(tokenCache.value)) return tokenCache.value;
    const s = secure();
    if (s?.get) {
      const gen = tokenGeneration;
      try {
        const v = await s.get(TOKEN_KEY);
        const t = isValidToken(v) ? v : null;
        if (gen !== tokenGeneration) return tokenCache.value;
        tokenCache = { value: t, at: Date.now() };
        return t;
      } catch (err) {
        if (usesKeychain()) throw err;
      }
    }
    if (usesKeychain()) return null;
    const raw = (storeGet(TOKEN_KEY) || "").trim();
    const t = isValidToken(raw) ? raw : null;
    tokenCache = { value: t, at: Date.now() };
    return t;
  }

  async function setStoredToken(token) {
    const t = String(token || "").trim();
    tokenGeneration++;
    if (!t) {
      const s = secure();
      if (s?.remove) {
        try {
          const removed = await s.remove(TOKEN_KEY);
          if (!removed && usesKeychain()) return { ok: false, error: "Keychain 清除失败，请稍后重试" };
        } catch {
          if (usesKeychain()) return { ok: false, error: "Keychain 清除失败，请稍后重试" };
        }
      }
      if (usesKeychain()) {
        tokenCache = { value: null, at: 0 };
        userIdCache = { value: null, at: 0, token: null };
        return { ok: true, backend: "keychain" };
      }
      storeRemove(TOKEN_KEY);
      tokenCache = { value: null, at: 0 };
      userIdCache = { value: null, at: 0, token: null };
      return { ok: true };
    }
    if (!isValidToken(t)) {
      return { ok: false, error: "ClickUp token 须以 pk_ 开头且足够长" };
    }
    const s = secure();
    let ok = false;
    if (s?.set) {
      try {
        ok = await s.set(TOKEN_KEY, t);
      } catch {
        ok = false;
      }
    }
    if (!ok && usesKeychain()) {
      return { ok: false, error: "Keychain 保存失败；为保护 Token，未写入本地存储" };
    }
    if (!ok) ok = storeSet(TOKEN_KEY, t);
    if (!ok) {
      return { ok: false, error: "无法保存 ClickUp Token（本地存储不可用）" };
    }
    if (tokenCache.value !== t) userIdCache = { value: null, at: 0, token: null };
    tokenCache = { value: t, at: Date.now() };
    // 新凭证就绪：把因缺 token / 鉴权失败而搁置的记录放回队列再补传
    retryFailedQueue({ includeAuth: true }).then(() => flushQueue()).catch(() => {});
    return { ok: true, backend: s?.backend?.() || "localStorage" };
  }

  async function readToken({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && tokenCache.at && now - tokenCache.at < LIMITS.tokenCacheMs) {
      return tokenCache.value;
    }
    return getStoredToken();
  }

  function invalidateToken() {
    tokenCache = { value: null, at: 0 };
    userIdCache = { value: null, at: 0, token: null };
  }

  async function cu(token, method, urlPath, body) {
    const ctrl = new AbortController();
    // 一个 deadline 覆盖「发请求 + 读正文」全过程：iOS 原生 HTTP 会忽略 AbortSignal，
    // 只给正文读取设超时的话，迟迟不回包的 POST 会一直占着上传与队列单飞锁。
    let onAbort;
    const timedOut = new Promise((_, reject) => {
      onAbort = () => {
        const err = new Error("ClickUp 请求超时");
        err.name = "AbortError";
        reject(err);
      };
      ctrl.signal.addEventListener("abort", onAbort, { once: true });
    });
    timedOut.catch(() => {});
    const timer = setTimeout(() => ctrl.abort(), LIMITS.requestTimeoutMs);
    let res;
    let text;
    try {
      res = await Promise.race([
        fetch(API + urlPath, {
          method,
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        }),
        timedOut,
      ]);
      // Keep the same deadline while consuming the body. A peer that sends
      // headers but never finishes its body must not freeze the flush lock.
      text = await Promise.race([res.text(), timedOut]);
    } finally {
      clearTimeout(timer);
      ctrl.signal.removeEventListener("abort", onAbort);
    }
    // 只有「收到完整响应、且状态码是 4xx 明确拒绝（含 429 限流）」才算服务端确定没执行（definite）。
    // 传输失败、正文读取失败、2xx 正文无法解析、5xx 一律视为结果未知。
    const definite = !res.ok && res.status >= 400 && res.status < 500;
    if (text.length > LIMITS.maxResponseChars) {
      const err = new Error("ClickUp 响应过大");
      err.status = res.status;
      err.retryable = false;
      if (definite) err.definite = true;
      throw err;
    }
    if (!res.ok) {
      if (res.status === 401) invalidateToken();
      const err = new Error("ClickUp " + res.status + ": " + redactSecrets(text).slice(0, 200));
      err.status = res.status;
      err.retryable = res.status === 429 || res.status >= 500;
      if (definite) err.definite = true;
      throw err;
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error("ClickUp 返回了非 JSON 响应");
      err.retryable = false;
      throw err;
    }
  }

  /** 任务标题的唯一规范化入口（与 app.js 的 MAX_TEXT=500 一致） */
  function cleanTaskTitle(s) {
    return String(s || "").trim().slice(0, LIMITS.maxTaskTitleChars);
  }
  const normTitle = (s) => cleanTaskTitle(s).toLowerCase();

  function rememberTasks(tasks) {
    const at = Date.now();
    for (const t of tasks) {
      if (!t || typeof t.name !== "string" || !t.id) continue;
      const key = normTitle(t.name);
      if (!key) continue;
      const id = String(t.id);
      const prev = taskCache.get(key);
      if (!prev) taskCache.set(key, { id, at });
      else if (prev.id === id) prev.at = at;
    }
  }

  function forgetTaskId(id) {
    if (!id) return Promise.resolve(true);
    const sid = String(id);
    for (const [k, v] of taskCache) {
      if (v && v.id === sid) taskCache.delete(k);
    }
    // 远端已删的任务：持久映射一并作废，否则另一页/下一次仍会把时间记到不存在的任务上
    if (!readTaskMap().some((x) => x.taskId === sid)) return Promise.resolve(true);
    return mutateStore(() => storeSet(TASK_MAP_KEY, JSON.stringify(readTaskMap().filter((x) => x.taskId !== sid))));
  }

  /* ---------- 审查五 D：持久化的「标题 → 已确认任务 id」映射 ---------- */
  /** 账号指纹：token 的不可逆短哈希（不落明文）。换 token 即换命名空间，绝不跨账号复用任务 id */
  function accountFingerprint(token) {
    const raw = String(token || "");
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ (c + i), 0x85ebca6b);
    }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
  }
  function taskMapKey(token, key) {
    return accountFingerprint(token) + "|" + listId() + "|" + key;
  }
  function readTaskMap() {
    try {
      const arr = JSON.parse(storeGet(TASK_MAP_KEY) || "[]");
      if (!Array.isArray(arr)) return [];
      const now = Date.now();
      return arr.filter(
        (x) => x && typeof x.k === "string" && isClickUpTaskId(x.taskId) &&
          Number.isFinite(x.at) && now - x.at < LIMITS.taskMapTtlMs
      );
    } catch {
      return [];
    }
  }
  function findMappedTask(token, key) {
    const k = taskMapKey(token, key);
    const hit = readTaskMap().find((x) => x.k === k);
    return hit ? hit.taskId : null;
  }
  /** 在 store 锁内落盘；返回是否写成功（失败时调用方不得清掉建任务的 pending） */
  function rememberMappedTask(token, key, taskId) {
    if (!isClickUpTaskId(taskId)) return Promise.resolve(false);
    const k = taskMapKey(token, key);
    return mutateStore(() => {
      const list = readTaskMap().filter((x) => x.k !== k);
      list.push({ k, taskId: String(taskId), at: Date.now() });
      return storeSet(TASK_MAP_KEY, JSON.stringify(list.slice(-MAX_TASK_MAP)));
    });
  }

  function taskDescriptionText(task) {
    if (!task || typeof task !== "object") return "";
    const parts = [];
    if (typeof task.description === "string") parts.push(task.description);
    if (typeof task.text_content === "string") parts.push(task.text_content);
    if (typeof task.markdown_description === "string") parts.push(task.markdown_description);
    return parts.join("\n");
  }

  async function listTasksPages(token, { includeClosed = true, maxPages = MAX_LIST_PAGES } = {}) {
    const all = [];
    let exhausted = false;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({
        archived: "false",
        include_closed: includeClosed ? "true" : "false",
        subtasks: "false",
        page: String(page),
      });
      const listed = await cu(token, "GET", "/list/" + listId() + "/task?" + q);
      // 审查四⑧：200 但缺 tasks 数组（代理页、错误体、接口变形）不是「空清单」，而是查询失败
      if (!listed || typeof listed !== "object" || !Array.isArray(listed.tasks)) {
        const err = new Error("ClickUp 任务列表响应格式异常（缺少 tasks 数组）");
        err.retryable = true;
        err.inconclusive = true;
        err.badShape = true;
        throw err;
      }
      const tasks = listed.tasks;
      rememberTasks(tasks);
      all.push(...tasks);
      // Page size is not an API contract. Only an explicit last page (or an
      // empty page) proves that a missing marker was not simply beyond scan.
      if (listed.last_page === true || tasks.length === 0) {
        exhausted = true;
        break;
      }
    }
    return { tasks: all, exhausted };
  }

  async function findTaskByOpMarker(token, operationId) {
    if (!operationId) return null;
    const marker = opMarker(operationId);
    try {
      const { tasks, exhausted } = await listTasksPages(token, { includeClosed: true });
      for (const t of tasks) {
        const blob = taskDescriptionText(t);
        if (blob.includes(marker) || extractOpId(blob) === operationId) {
          return t;
        }
      }
      if (!exhausted) {
        const err = new Error("清单超出可扫描页数，无法确认任务是否已创建");
        err.inconclusive = true;
        throw err;
      }
    } catch (err) {
      err.queryFailed = true;
      throw err;
    }
    return null;
  }

  function taskIndeterminate(cause, operationId) {
    const err = new Error(
      (cause ? redactSecrets(String(cause.message || cause)).slice(0, 160) + "；" : "") +
        "新建 ClickUp 任务的结果尚未确认，只做核对、不会重复创建；这条打卡已保留"
    );
    err.code = "TASK_INDETERMINATE";
    err.taskIndeterminate = true;
    err.retryable = true;
    err.taskOperationId = operationId || null;
    return err;
  }

  /**
   * 按标题找任务，找不到才新建（番茄打卡用）。
   * 审查四⑦：新建任务的 POST 带稳定 marker，发出前先落盘「不确定」记录；
   * 结果未知（传输失败、5xx、读正文失败、2xx 无 id）时记录保留，之后只按 marker 对账，
   * 绝不自动重发。只有明确成功/明确拒绝才清掉记录。
   */
  async function ensureTask(token, title, dueTs) {
    const key = normTitle(title);
    const hit = taskCache.get(key);
    if (hit && Date.now() - hit.at < LIMITS.taskCacheMs) return hit.id;
    const pending = ensureInflight.get(key);
    if (pending) return pending;

    // 同名建任务跨页串行：后到者在锁内能看到先到者的不确定记录或结果
    const work = withLock("task:" + key, async () => {
      const again = taskCache.get(key);
      if (again && Date.now() - again.at < LIMITS.taskCacheMs) return again.id;
      // 审查五 D：别页已确认过的任务（刚建完、列表查询可能还看不到）→ 直接用，不再建
      const mapped = findMappedTask(token, key);
      if (mapped) {
        taskCache.set(key, { id: mapped, at: Date.now() });
        return mapped;
      }

      const pend = findPendingTask(key);
      if (pend) {
        let found = null;
        try {
          found = await findTaskByOpMarker(token, pend.operationId);
        } catch (err) {
          throw taskIndeterminate(err, pend.operationId);
        }
        if (!found || !found.id) {
          const createdAt = Number(pend.createdAt);
          if (!Number.isFinite(createdAt) || Date.now() - createdAt >= LIMITS.pendingRequeueGraceMs) {
            await markPendingTaskManual(key);
          }
          throw taskIndeterminate(null, pend.operationId);
        }
        const id = String(found.id);
        // 先持久化确认结果再清 pending：映射写不进去就留着 pending，下次继续按 marker 对账
        if (await rememberMappedTask(token, key, id)) await clearPendingTask(key, pend.operationId);
        taskCache.set(key, { id, at: Date.now() });
        return id;
      }

      const { tasks, exhausted } = await listTasksPages(token, {
        includeClosed: false,
        maxPages: MAX_LIST_PAGES,
      });
      const found = tasks.find((t) => normTitle(t.name) === key);
      if (!found && !exhausted) {
        const err = new Error("清单过大，无法确认同名任务是否已存在");
        err.retryable = false;
        err.inconclusive = true;
        throw err;
      }
      let id;
      if (found && found.id) {
        id = String(found.id);
      } else {
        const operationId = newId("ptask-");
        const body = {
          name: title,
          description: "从 Lumina Todo 番茄打卡创建\n" + opMarker(operationId),
        };
        if (Number.isFinite(dueTs) && dueTs > 0) {
          body.due_date = dueTs;
          body.due_date_time = false;
        }
        if (!(await upsertPendingTask({ key, operationId, title, createdAt: Date.now() }))) {
          const err = new Error("无法保存新建任务的核对记录，已取消提交以避免重复创建");
          err.code = "PENDING_WRITE_FAILED";
          err.retryable = true;
          throw err;
        }
        let made;
        try {
          made = await cu(token, "POST", "/list/" + listId() + "/task", body);
        } catch (err) {
          if (isDefiniteRejection(err)) {
            await clearPendingTask(key, operationId);
            throw err;
          }
          // 结果未知：立刻按 marker 查一次，查到就用；查不到/查询失败都保留记录，不重发
          let late = null;
          try {
            late = await findTaskByOpMarker(token, operationId);
          } catch {
            late = null;
          }
          if (!late || !late.id) throw taskIndeterminate(err, operationId);
          made = late;
        }
        if (!made || !made.id) throw taskIndeterminate(new Error("ClickUp 创建任务未返回 id"), operationId);
        id = String(made.id);
        // 审查五 D：确认结果落盘成功后才清 pending；否则 pending 留着，别页只会按 marker 对账、不会重建
        if (await rememberMappedTask(token, key, id)) await clearPendingTask(key, operationId);
      }
      if (found && found.id) await rememberMappedTask(token, key, id);
      taskCache.set(key, { id, at: Date.now() });
      return id;
    });

    ensureInflight.set(key, work);
    try {
      return await work;
    } finally {
      ensureInflight.delete(key);
    }
  }

  function readQueue() {
    const raw = storeGet(QUEUE_KEY);
    try {
      const arr = JSON.parse(raw || "[]");
      if (!Array.isArray(arr)) return [];
      return arr.map((item) => ({
        ...item,
        queueId:
          typeof item?.queueId === "string" && item.queueId
            ? item.queueId
            : newQueueId(),
        operationId:
          typeof item?.operationId === "string" && item.operationId
            ? item.operationId
            : newOpId(),
      }));
    } catch {
      // Keep evidence instead of silently overwriting unsynced records after a
      // partial/corrupt localStorage write.
      if (!storeGet(CORRUPT_QUEUE_KEY)) {
        storeSet(
          CORRUPT_QUEUE_KEY,
          JSON.stringify({ savedAt: Date.now(), raw: String(raw || "").slice(0, 128 * 1024) })
        );
      }
      return [];
    }
  }
  /** 只在 mutateStore 的同步临界区里调用 */
  function writeQueue(arr) {
    return storeSet(QUEUE_KEY, JSON.stringify(arr));
  }
  /** 队列读-改-写（全局 store 锁内）：fn(q) 改 q 并返回结果；返回 false 表示不写 */
  function mutateQueue(fn, fallback = { ok: false, lock: true }) {
    return mutateStore(() => {
      const q = readQueue();
      const r = fn(q);
      if (r === false) return { ok: false, q };
      if (!writeQueue(q)) return { ok: false, q, writeFailed: true };
      return { ok: true, q, value: r };
    }, fallback);
  }
  function readFailedQueue() {
    try {
      const arr = JSON.parse(storeGet(FAILED_QUEUE_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function writeFailedQueue(arr) {
    return storeSet(FAILED_QUEUE_KEY, JSON.stringify(arr));
  }
  function recordFailedSync(item, result) {
    const failed = readFailedQueue().filter((entry) => entry.queueId !== item.queueId);
    // 失败记录满了就拒绝写入：调用方会把这条留在队列里，而不是挤掉更早的失败记录
    if (failed.length >= MAX_FAILED) return false;
    failed.push({
      ...item,
      failedAt: Date.now(),
      failureCode: result?.code || "REQUEST_FAILED",
      failureReason: String(result?.error || "同步失败").slice(0, 300),
      failureRetryable: result?.retryable !== false,
    });
    return writeFailedQueue(failed);
  }
  // 凭证类失败：换上新 token 后可以重试（旧版本会把缺 token 的离线记录误记为永久失败）
  const AUTH_FAILURE_CODES = new Set(["NO_TOKEN", "HTTP_401", "HTTP_403"]);
  function retryFailedQueue({ includeAuth = false } = {}) {
    return mutateStore(() => {
      const failed = readFailedQueue();
      if (!failed.length) return { restored: 0, left: 0 };
      const queue = readQueue();
      const ids = new Set(queue.map((entry) => entry.queueId));
      const retryableCodes = new Set(["TIMEOUT", "REQUEST_FAILED", "QUEUE_WRITE_FAILED"]);
      const keep = [];
      let room = Math.max(0, MAX_QUEUE - queue.length);
      const restore = failed
        .filter((entry) => {
          if (ids.has(entry.queueId)) return false;
          const code = entry.failureCode || "REQUEST_FAILED";
          const restorable =
            (includeAuth && AUTH_FAILURE_CODES.has(code)) ||
            (entry.failureRetryable !== false && retryableCodes.has(code));
          // 队列放不下的留在失败记录里，下次再放回，不挤掉队列里的记录
          if (!restorable || room <= 0) {
            keep.push(entry);
            return false;
          }
          room--;
          return true;
        })
        .map((entry) => ({
          queueId: entry.queueId || newQueueId(),
          operationId: entry.operationId || newOpId(),
          title: entry.title || "",
          taskId: isClickUpTaskId(entry.taskId) ? entry.taskId : null,
          minutes: entry.minutes,
          endedAt: entry.endedAt,
          tries: 0,
          queuedAt: entry.queuedAt || Date.now(),
        }));
      if (!writeQueue(queue.concat(restore))) return { restored: 0, left: failed.length, error: "QUEUE_WRITE_FAILED" };
      if (!writeFailedQueue(keep)) return { restored: 0, left: failed.length, error: "FAILED_QUEUE_WRITE_FAILED" };
      return { restored: restore.length, left: keep.length };
    }, { restored: 0, left: readFailedQueue().length, error: "LOCK_UNAVAILABLE" });
  }
  function clearFailedQueue() {
    return mutateStore(() => writeFailedQueue([]));
  }
  function enqueueSync(entry) {
    const q = readQueue();
    if (q.length >= MAX_QUEUE) return false;
    q.push({
      queueId: newQueueId(),
      operationId: newOpId(entry.operationId),
      title: typeof entry.title === "string" ? entry.title : "",
      taskId: isClickUpTaskId(entry.taskId) ? entry.taskId : null,
      minutes: entry.minutes,
      endedAt: entry.endedAt,
      tries: 0,
      queuedAt: Date.now(),
    });
    return writeQueue(q);
  }

  function readPendingPushes() {
    try {
      const arr = JSON.parse(storeGet(PENDING_PUSH_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function writePendingPushes(arr) {
    return storeSet(PENDING_PUSH_KEY, JSON.stringify(arr));
  }
  function upsertPendingPushSync(entry) {
    const list = readPendingPushes().filter((x) => x.operationId !== entry.operationId);
    if (list.length >= MAX_PENDING) return false;
    const rec = {
      operationId: entry.operationId,
      title: entry.title,
      priority: entry.priority || "",
      dueDate: entry.dueDate || null,
      createdAt: entry.createdAt || Date.now(),
      state: entry.state || "indeterminate",
    };
    // 远端已确认创建、但「已创建」缓存没写进去：taskId 留在 pending 里，重传直接复用
    if (isClickUpTaskId(entry.taskId)) {
      rec.taskId = entry.taskId;
      rec.url = entry.url || null;
      rec.state = "created";
    }
    if (entry.needsManual) rec.needsManual = true;
    list.push(rec);
    return writePendingPushes(list);
  }
  function upsertPendingPush(entry) {
    return mutateStore(() => upsertPendingPushSync(entry));
  }
  function markPendingPushManual(operationId) {
    return mutateStore(() => {
      const list = readPendingPushes();
      const item = list.find((x) => x.operationId === operationId);
      if (!item || item.needsManual) return Boolean(item);
      item.needsManual = true;
      return writePendingPushes(list);
    });
  }
  /**
   * 远端已有 taskId：先可靠写入「已创建」记录，成功后才清 pending；
   * 写失败就把 taskId 留在 pending，下次直接复用，绝不再 POST。
   * 整段在 store 锁内：别页对其它 operationId 的写入不会把这条覆盖掉。
   */
  function settleCreatedPush(operationId, taskId, url, meta) {
    return mutateStore(() => {
      if (rememberPushedSync(operationId, taskId, url)) {
        writePendingPushes(readPendingPushes().filter((x) => x.operationId !== operationId));
        return true;
      }
      const prev = readPendingPushes().find((x) => x.operationId === operationId) || {};
      upsertPendingPushSync({
        operationId,
        title: (meta && meta.title) || prev.title || "",
        priority: (meta && meta.priority) || prev.priority || "",
        dueDate: (meta && meta.dueDate) || prev.dueDate || null,
        createdAt: prev.createdAt,
        taskId,
        url,
      });
      return false;
    });
  }
  function clearPendingPush(operationId) {
    return mutateStore(() =>
      writePendingPushes(readPendingPushes().filter((x) => x.operationId !== operationId))
    );
  }

  /**
   * 已确认创建成功的上传：operationId → taskId。远端成功但 App 没能把关联存下来
   * （本地写失败、页面被杀、从备份恢复）时，同一待办再传直接复用，不再 POST。
   * 这只是确认缓存，超出上限淘汰最旧的也不会丢数据（远端 marker 查询兜底）。
   */
  function readPushedRecords() {
    try {
      const arr = JSON.parse(storeGet(PUSHED_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function findPushedRecord(operationId) {
    return readPushedRecords().find((x) => x && x.operationId === operationId && isClickUpTaskId(x.taskId)) || null;
  }
  function rememberPushedSync(operationId, taskId, url) {
    if (!operationId || !isClickUpTaskId(taskId)) return false;
    const list = readPushedRecords().filter((x) => x && x.operationId !== operationId);
    list.push({ operationId, taskId, url: url || null, at: Date.now() });
    return storeSet(PUSHED_KEY, JSON.stringify(list.slice(-MAX_PUSHED)));
  }

  function readPendingPomos() {
    try {
      const arr = JSON.parse(storeGet(PENDING_POMO_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function writePendingPomos(arr) {
    return storeSet(PENDING_POMO_KEY, JSON.stringify(arr));
  }
  /** 已确认写入、只等队列项移除的回执（审查四⑥）：不算「待核对」 */
  function isConfirmedPomo(item) {
    return Boolean(item && item.state === "confirmed");
  }
  function pendingPomosFull(operationId) {
    const list = readPendingPomos();
    return list.length >= MAX_PENDING && !list.some((item) => item.operationId === operationId);
  }
  function upsertPendingPomo(entry) {
    return mutateStore(() => {
      const list = readPendingPomos().filter((item) => item.operationId !== entry.operationId);
      if (list.length >= MAX_PENDING) return false;
      // rev：每次写入换新版本号，清除时比对（compare-and-clear），旧快照清不掉新记录
      list.push({ ...entry, createdAt: entry.createdAt || Date.now(), rev: newId("rev-") });
      return writePendingPomos(list);
    });
  }
  /**
   * 审查四⑥：POST 成功后先把待核对记录改成「已确认」回执（同一把锁内落盘），
   * 队列项移除成功后才清掉回执。回执在时任何重试都直接判成功，不依赖远端立即可见。
   */
  function markPendingPomoConfirmed(operationId, taskId) {
    return mutateStore(() => {
      const list = readPendingPomos();
      const item = list.find((x) => x.operationId === operationId);
      if (!item) return false;
      item.state = "confirmed";
      item.confirmedAt = Date.now();
      if (taskId) item.confirmedTaskId = String(taskId);
      item.rev = newId("rev-");
      delete item.needsManual;
      return writePendingPomos(list);
    });
  }
  function markPendingPomoManual(operationId) {
    return mutateStore(() => {
      const list = readPendingPomos();
      const item = list.find((x) => x.operationId === operationId);
      if (!item || item.needsManual || isConfirmedPomo(item)) return Boolean(item);
      item.needsManual = true;
      return writePendingPomos(list);
    });
  }
  function clearPendingPomo(operationId) {
    return mutateStore(() =>
      writePendingPomos(readPendingPomos().filter((item) => item.operationId !== operationId))
    );
  }
  /** 仅当当前记录仍是 expected 那一版时才清除；返回是否清掉 */
  function clearPendingPomoIfSync(operationId, expectedRev) {
    const list = readPendingPomos();
    const cur = list.find((item) => item.operationId === operationId);
    if (!cur || (cur.rev ?? null) !== (expectedRev ?? null)) return false;
    return writePendingPomos(list.filter((item) => item !== cur));
  }
  function currentPendingPomo(operationId) {
    return readPendingPomos().find((item) => item.operationId === operationId) || null;
  }
  function hasPendingPomo(operationId) {
    return readPendingPomos().some((item) => item.operationId === operationId);
  }
  function pendingPomoAge(operationId) {
    const pending = readPendingPomos().find((item) => item.operationId === operationId);
    if (!pending) return null;
    const createdAt = Number(pending.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return 0;
    return Date.now() - createdAt;
  }
  /**
   * 用户手动重试且查询已确认远端没有这条记录：按原 operationId 转入补发队列（绝不自动调用）。
   * 「比对版本 → 入队 → 清 pending」整段在 store 锁内一次完成。
   * 补发时 logPomodoro 会再预查一次，预查失败不会 POST。
   */
  function requeuePendingPomo(pending) {
    return mutateStore(() => {
      // compare-and-clear：读到的这一版已被别的流程改写/清除（例如另一次重试已开始
      // POST 并写入新 pending），就什么都不做——旧快照绝不能清掉新记录
      const cur = currentPendingPomo(pending.operationId);
      if (!cur || (cur.rev ?? null) !== (pending.rev ?? null)) return "stale";
      const already = readQueue().some((item) => item.operationId === pending.operationId);
      if (!already && !enqueueSync({
        title: typeof pending.title === "string" ? pending.title : "",
        taskId: pending.taskId,
        minutes: pending.minutes,
        endedAt: pending.endedAt,
        operationId: pending.operationId,
      })) {
        return false;
      }
      return clearPendingPomoIfSync(pending.operationId, pending.rev);
    });
  }

  /* ---------- 审查五 C：番茄打卡的独立完成回执 ---------- */
  function readPomoDone() {
    try {
      const arr = JSON.parse(storeGet(POMO_DONE_KEY) || "[]");
      if (!Array.isArray(arr)) return [];
      const now = Date.now();
      return arr.filter(
        (x) => x && typeof x.operationId === "string" && Number.isFinite(x.at) && now - x.at < LIMITS.pomoDoneTtlMs
      );
    } catch {
      return [];
    }
  }
  function findPomoDone(operationId) {
    if (!operationId) return null;
    return readPomoDone().find((x) => x.operationId === operationId) || null;
  }
  /** 同步写（调用方须已持有 store 锁）。容量满时淘汰最旧的（已过远端可见延迟，marker 预查兜底） */
  function rememberPomoDoneSync(operationId, taskId) {
    const list = readPomoDone().filter((x) => x.operationId !== operationId);
    list.push({ operationId, taskId: taskId ? String(taskId) : null, at: Date.now() });
    return storeSet(POMO_DONE_KEY, JSON.stringify(list.slice(-MAX_POMO_DONE)));
  }

  /* ---------- 审查四⑦：番茄打卡按标题新建任务的不确定记录 ---------- */
  function readPendingTasks() {
    try {
      const arr = JSON.parse(storeGet(PENDING_TASK_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function findPendingTask(key) {
    return readPendingTasks().find((x) => x && x.key === key) || null;
  }
  function upsertPendingTask(rec) {
    return mutateStore(() => {
      const list = readPendingTasks().filter((x) => x && x.key !== rec.key);
      if (list.length >= MAX_PENDING) return false;
      list.push(rec);
      return storeSet(PENDING_TASK_KEY, JSON.stringify(list));
    });
  }
  function markPendingTaskManual(key) {
    return mutateStore(() => {
      const list = readPendingTasks();
      const item = list.find((x) => x && x.key === key);
      if (!item || item.needsManual) return Boolean(item);
      item.needsManual = true;
      return storeSet(PENDING_TASK_KEY, JSON.stringify(list));
    });
  }
  function clearPendingTask(key, operationId) {
    return mutateStore(() => {
      const list = readPendingTasks();
      const next = list.filter((x) => !(x && x.key === key && (!operationId || x.operationId === operationId)));
      if (next.length === list.length) return true;
      return storeSet(PENDING_TASK_KEY, JSON.stringify(next));
    });
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  /**
   * 写请求（POST）发出后的失败分类：只有服务端明确拒绝（完整响应的 4xx，见 cu()）
   * 才能证明远端没有落库，允许清除 pending；其余（Failed to fetch、Load failed、
   * 连接重置、正文读取/解析失败、超时、5xx）都可能已提交，必须保留「不确定」。
   */
  function isDefiniteRejection(err) {
    return Boolean(err && err.definite === true && Number.isFinite(err.status) && err.status >= 400 && err.status < 500);
  }

  function isTimeoutError(err) {
    if (!err) return false;
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    return /timeout|aborted/i.test(String(err.message || ""));
  }

  function isRealISODate(iso) {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function todayISODate(now = Date.now()) {
    const d = new Date(now);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }
  function startDateToMs(iso) {
    if (!isRealISODate(iso)) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  function dueDateToMs(iso) {
    if (!isRealISODate(iso)) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 18, 0, 0, 0).getTime();
  }
  function resolveTaskSchedule(dueDate, now = Date.now()) {
    const day = isRealISODate(dueDate) ? dueDate : todayISODate(now);
    const startMs = startDateToMs(day);
    const dueMs = dueDateToMs(day);
    if (!startMs || !dueMs) return null;
    return { day, startMs, dueMs };
  }
  function mapPriority(priority) {
    if (priority === "high") return 2;
    if (priority === "medium") return 3;
    if (priority === "low") return 4;
    return null;
  }
  function isClickUpTaskId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
  }
  function safeClickUpTaskUrl(url, taskId) {
    if (typeof url === "string" && url.length > 0 && url.length <= 300) {
      try {
        const u = new URL(url);
        if (
          u.protocol === "https:" &&
          (u.hostname === "app.clickup.com" || u.hostname === "clickup.com")
        ) {
          return u.toString();
        }
      } catch {
        /* fall */
      }
    }
    if (isClickUpTaskId(taskId)) return "https://app.clickup.com/t/" + taskId;
    return null;
  }

  async function getSelfUserId(token) {
    const now = Date.now();
    if (
      userIdCache.value &&
      userIdCache.token === token &&
      now - userIdCache.at < LIMITS.taskCacheMs
    ) {
      return userIdCache.value;
    }
    const data = await cu(token, "GET", "/user");
    const id = data && data.user && data.user.id;
    if (!id && id !== 0) {
      const err = new Error("ClickUp 未返回当前用户 id");
      err.retryable = true;
      throw err;
    }
    userIdCache = { value: String(id), at: now, token };
    return userIdCache.value;
  }

  async function findTimeEntryByOpMarker(token, start, duration, operationId) {
    if (!operationId) return null;
    const marker = opMarker(operationId);
    const pad = 5 * 60 * 1000;
    const startDate = Math.max(0, start - pad);
    const endDate = start + duration + pad;
    const q = new URLSearchParams({
      start_date: String(startDate),
      end_date: String(endDate),
      include_task_tags: "false",
    });
    try {
      const data = await cu(token, "GET", "/team/" + teamId() + "/time_entries?" + q);
      // 审查四⑧：缺 data 数组的 200 响应不能当作「查无」——否则会补发并清掉待核对
      let entries;
      if (Array.isArray(data?.data)) entries = data.data;
      else if (Array.isArray(data)) entries = data;
      else {
        const err = new Error("ClickUp 时间记录响应格式异常（缺少 data 数组）");
        err.retryable = true;
        err.badShape = true;
        throw err;
      }
      for (const e of entries) {
        const desc = typeof e?.description === "string" ? e.description : "";
        if (desc.includes(marker) || extractOpId(desc) === operationId) return e;
      }
    } catch (err) {
      err.queryFailed = true;
      throw err;
    }
    return null;
  }

  async function postTimeEntry(token, tid, start, duration, mins, operationId) {
    const marker = operationId ? " " + opMarker(operationId) : "";
    await cu(token, "POST", "/team/" + teamId() + "/time_entries", {
      tid,
      start,
      duration,
      description: "番茄钟 " + mins + " 分钟 · Lumina Todo" + marker,
    });
  }

  /**
   * 审查四⑥：远端已确认有这条打卡。在 store 锁内把待核对记录改成「已确认」回执；
   * 队列里没有同 operationId 的补发项时顺手清掉回执（同一临界区，原子）。
   * 有队列项时回执保留，直到 flush 把队列项移除成功（同一临界区里一起清）。
   */
  function confirmPomo(operationId, taskId) {
    return mutateStore(() => {
      const list = readPendingPomos();
      const item = list.find((x) => x.operationId === operationId);
      const queued = readQueue().some((x) => x.operationId === operationId);
      // 审查五 C：先落独立完成回执（成功/无队列项/队列项移除都不清）。写不进去就不清 pending：
      // 保留「不确定/已确认」记录，任何重试只对账、不会再 POST
      const doneOk = rememberPomoDoneSync(operationId, taskId);
      if (!doneOk) {
        if (!item) return false;
        if (isConfirmedPomo(item)) return false;
        item.state = "confirmed";
        item.confirmedAt = Date.now();
        if (taskId) item.confirmedTaskId = String(taskId);
        item.rev = newId("rev-");
        delete item.needsManual;
        writePendingPomos(list);
        return false;
      }
      if (!queued) {
        if (!item) return true;
        return writePendingPomos(list.filter((x) => x !== item));
      }
      const rec = item || { operationId, createdAt: Date.now() };
      rec.state = "confirmed";
      rec.confirmedAt = Date.now();
      if (taskId) rec.confirmedTaskId = String(taskId);
      rec.rev = newId("rev-");
      delete rec.needsManual;
      if (!item) list.push(rec);
      return writePendingPomos(list);
    });
  }

  /** A timeout/5xx can be committed remotely after the client loses the reply. */
  async function settleUncertainPomo(token, { start, duration, operationId, taskId, name, minutes, noQueue, cause }) {
    try {
      const hit = await findTimeEntryByOpMarker(token, start, duration, operationId);
      if (hit) {
        await confirmPomo(operationId, hit.task?.id || taskId);
        if (!noQueue) flushQueue().catch(() => {});
        return {
          ok: true,
          taskId: hit.task?.id || taskId,
          name,
          minutes,
          recovered: true,
          operationId,
        };
      }
    } catch {
      // A failed lookup is still unknown; the pending record is deliberately kept.
    }
    return {
      ok: false,
      code: "INDETERMINATE",
      error:
        redactSecrets(String(cause?.message || cause)).slice(0, 200) +
        "；写入结果尚未确认，已保留待核对记录，确认未写入后才会补发",
      retryable: false,
      operationId,
      queued: false,
    };
  }

  function lockUnavailableResult(operationId, extra) {
    return {
      ok: false,
      code: "LOCK_UNAVAILABLE",
      error: "当前环境没有可靠的跨页面锁，为避免重复提交已暂停自动提交；记录已保留，换到 App 或新版浏览器后会继续",
      retryable: true,
      operationId,
      queued: false,
      ...(extra || {}),
    };
  }

  /**
   * 同一 operationId 的打卡（队列补发、手动重试、别页同段打卡）跨页面串行：
   * 后到者在锁内预查时能看到先到者的结果或 pending，不会两边同时 POST。
   * 审查四④：拿不到可靠的跨页锁就不提交（新打卡尽量放进本地队列，等有锁时再补）。
   */
  async function logPomodoro(opts) {
    const callerOp =
      typeof opts?.operationId === "string" && /^[A-Za-z0-9._:-]{6,80}$/.test(opts.operationId)
        ? opts.operationId
        : null;
    const op = callerOp || newOpId();
    try {
      return await withLock("pomo-op:" + op, () => logPomodoroImpl({ ...(opts || {}), __opId: op }));
    } catch (err) {
      if (!isLockUnavailable(err)) throw err;
      if (opts && opts.__noQueue) return lockUnavailableResult(op);
      // 新打卡：没锁也先把记录留在本地队列（不提交）。队列写入同样需要锁，写不进去就如实告知
      const mins = Math.round(Number(opts && opts.minutes));
      if (!Number.isFinite(mins) || mins <= 0 || mins > LIMITS.maxMinutes) {
        return { ok: false, code: "BAD_ARGS", error: "minutes 不合法", retryable: false };
      }
      let endedAt = Number(opts && opts.endedAt);
      if (!Number.isFinite(endedAt) || endedAt <= 0) endedAt = Date.now();
      return enqueuePomoResult(lockUnavailableResult(op), {
        title: cleanTaskTitle(opts && opts.title),
        taskId: isClickUpTaskId(opts && opts.taskId) ? opts.taskId : null,
        minutes: mins,
        endedAt,
        operationId: op,
      });
    }
  }

  async function logPomodoroImpl(opts) {
    const { title } = opts || {};
    let endedAt = Number(opts && opts.endedAt);
    if (!Number.isFinite(endedAt) || endedAt <= 0) endedAt = Date.now();
    const now = Date.now();
    if (endedAt > now + LIMITS.endedAtSkewMs) endedAt = now;

    const mins = Math.round(Number(opts && opts.minutes));
    if (!Number.isFinite(mins) || mins <= 0) {
      return { ok: false, code: "BAD_ARGS", error: "minutes 不合法", retryable: false };
    }
    if (mins > LIMITS.maxMinutes) {
      return {
        ok: false,
        code: "BAD_ARGS",
        error: "minutes 超过上限 " + LIMITS.maxMinutes,
        retryable: false,
      };
    }

    const token = await readToken();
    if (!token) {
      return {
        ok: false,
        code: "NO_TOKEN",
        error: "没找到 ClickUp token。请在设置里粘贴 pk_… 密钥。",
        retryable: false,
      };
    }

    const clean = cleanTaskTitle(title);
    const name = clean || "番茄钟 · " + dayLabel(endedAt);
    // 待办已上传过 ClickUp 时直接记到那个任务上，不再按标题查找/新建
    const knownTaskId = isClickUpTaskId(opts && opts.taskId) ? opts.taskId : null;
    const duration = mins * 60 * 1000;
    const start = endedAt - duration;
    if (!Number.isFinite(start) || start <= 0) {
      return { ok: false, code: "BAD_ARGS", error: "endedAt/时长不合法", retryable: false };
    }

    const callerOpId =
      typeof opts?.operationId === "string" && /^[A-Za-z0-9._:-]{6,80}$/.test(opts.operationId)
        ? opts.operationId
        : null;
    const operationId = newOpId(callerOpId || opts?.__opId);
    const noQueue = Boolean(opts && opts.__noQueue);
    const failPayload = (err) => ({
      ok: false,
      code: err?.taskIndeterminate
        ? "TASK_INDETERMINATE"
        : isLockUnavailable(err)
          ? "LOCK_UNAVAILABLE"
          : err?.code === "PENDING_WRITE_FAILED"
            ? "PENDING_WRITE_FAILED"
            : isTimeoutError(err)
              ? "TIMEOUT"
              : Number.isFinite(err?.status) && err.status >= 400 && err.status < 500
                ? "HTTP_" + err.status
                : "REQUEST_FAILED",
      error: redactSecrets(String((err && err.message) || err)).slice(0, 300),
      retryable: err && err.retryable === false ? false : true,
      operationId,
    });

    {
      // 审查五 C：独立完成回执（锁内先查）→ 这条已经写进 ClickUp，绝不再 POST
      const done = findPomoDone(operationId);
      if (done) {
        if (!noQueue && hasPendingPomo(operationId)) await confirmPomo(operationId, done.taskId);
        return {
          ok: true,
          taskId: done.taskId || knownTaskId,
          name,
          minutes: mins,
          deduped: true,
          localReceipt: true,
          operationId,
        };
      }
    }
    if (callerOpId) {
      // 审查四⑥：本机已有「已确认」回执 → 远端肯定有这条，直接判成功，不依赖远端立即可见
      const receipt = currentPendingPomo(operationId);
      if (isConfirmedPomo(receipt)) {
        if (!noQueue) await confirmPomo(operationId, receipt.confirmedTaskId);
        return {
          ok: true,
          taskId: receipt.confirmedTaskId || knownTaskId,
          name,
          minutes: mins,
          deduped: true,
          localReceipt: true,
          operationId,
        };
      }
    }

    // A random id created for a brand-new request cannot be found remotely.
    // Preflight only when the caller supplied a stable retry/idempotency key.
    if (callerOpId) try {
      const existing = await findTimeEntryByOpMarker(token, start, duration, operationId);
      if (existing) {
        if (hasPendingPomo(operationId)) await confirmPomo(operationId, existing.task?.id || existing.tid);
        if (!noQueue) flushQueue().catch(() => {});
        return {
          ok: true,
          taskId: existing.task?.id || existing.tid || null,
          name,
          minutes: mins,
          deduped: true,
          operationId,
        };
      }
      const pendingAge = pendingPomoAge(operationId);
      if (pendingAge !== null && pendingAge < LIMITS.pendingRequeueGraceMs) {
        return {
          ok: false,
          code: "INDETERMINATE",
          error: "上次提交结果尚未确认，暂不重发；会继续自动核对",
          retryable: false,
          operationId,
          queued: false,
        };
      }
      // 过了宽限期仍查无：不能证明原请求不会再提交，不自动补发，交给用户手动重试
      if (pendingAge !== null) {
        await markPendingPomoManual(operationId);
        return {
          ok: false,
          code: "NEEDS_MANUAL_RETRY",
          error: "上次提交长时间未确认（ClickUp 暂未查到），已停止自动补发；确认没有这条记录后可在设置里手动重试",
          retryable: false,
          needsManual: true,
          operationId,
          queued: false,
        };
      }
    } catch (err) {
      // A brand-new submission may proceed after a failed preflight. A queued
      // retry or existing pending record must never POST again without proof.
      if (noQueue || hasPendingPomo(operationId)) {
        return settleUncertainPomo(token, {
          start, duration, operationId, taskId: null, name, minutes: mins, noQueue, cause: err,
        });
      }
    }

    // 待核对记录已满：不能再发一条无法对账的 POST，也不能挤掉旧记录。
    // 先放进离线队列（队列补发时会再检查），等旧的待核对记录消化掉再提交。
    if (pendingPomosFull(operationId)) {
      const full = {
        ok: false,
        code: "PENDING_FULL",
        error: "待核对的打卡记录过多，这条暂缓提交",
        retryable: true,
        operationId,
      };
      if (noQueue) return full;
      return enqueuePomoResult(full, { title: clean, taskId: knownTaskId, minutes: mins, endedAt, operationId });
    }

    let pendingPomo = false;
    try {
      const tid = knownTaskId || (await ensureTask(token, name, endedAt));
      if (!(await upsertPendingPomo({
        operationId, title: clean, taskId: knownTaskId, minutes: mins, endedAt, start, duration,
      }))) {
        return {
          ok: false,
          code: "PENDING_WRITE_FAILED",
          error: "无法保存打卡对账记录，已取消提交以避免产生无法确认的记录",
          retryable: false,
          operationId,
        };
      }
      pendingPomo = true;
      try {
        await postTimeEntry(token, tid, start, duration, mins, operationId);
      } catch (err) {
        if (isDefiniteRejection(err) && err.status === 404) {
          // 已知任务在远端被删了：退回按标题查找/新建
          await forgetTaskId(tid);
          taskCache.delete(normTitle(name));
          const tid2 = await ensureTask(token, name, endedAt);
          try {
            await postTimeEntry(token, tid2, start, duration, mins, operationId);
          } catch (retryErr) {
            if (!isDefiniteRejection(retryErr)) {
              return settleUncertainPomo(token, {
                start, duration, operationId, taskId: tid2, name, minutes: mins, noQueue, cause: retryErr,
              });
            }
            throw retryErr;
          }
          await confirmPomo(operationId, tid2);
          if (!noQueue) flushQueue().catch(() => {});
          return { ok: true, taskId: tid2, name, minutes: mins, retried: true, operationId };
        }
        // 已发出的 POST 只要不是明确拒绝，结果就未知：保留 pending，先查再决定
        if (!isDefiniteRejection(err)) {
          return settleUncertainPomo(token, {
            start, duration, operationId, taskId: tid, name, minutes: mins, noQueue, cause: err,
          });
        }
        throw err;
      }
      // 审查四⑥：先落「已确认」回执（有队列项时保留到队列项移除成功），再返回成功
      await confirmPomo(operationId, tid);
      if (!noQueue) flushQueue().catch(() => {});
      return { ok: true, taskId: tid, name, minutes: mins, operationId };
    } catch (err) {
      if (pendingPomo) await clearPendingPomo(operationId);
      const result = failPayload(err);
      // 仅明确可重试且非 INDETERMINATE 时入队；入队复用 operationId
      if (!noQueue && result.retryable && result.code !== "INDETERMINATE") {
        return enqueuePomoResult(result, {
          title: clean,
          taskId: knownTaskId,
          minutes: mins,
          endedAt,
          operationId,
        });
      }
      return result;
    }
  }

  /** 入队并给出明确结果：队列满或写失败都要如实告诉调用方，不能显示「已入队」 */
  async function enqueuePomoResult(result, entry) {
    const r = await mutateStore(() => {
      if (readQueue().length >= MAX_QUEUE) return "full";
      return enqueueSync(entry) ? "ok" : "write";
    }, "lock");
    if (r !== "ok") {
      return {
        ...result,
        code: r === "full" ? "QUEUE_FULL" : r === "lock" ? "LOCK_UNAVAILABLE" : "QUEUE_WRITE_FAILED",
        retryable: false,
        queued: false,
        error:
          r === "full"
            ? result.error + "；离线队列已满（" + MAX_QUEUE + " 条），这条记录未保存"
            : r === "lock"
              ? "当前环境没有可靠的跨页面锁，无法安全保存或提交这条打卡（记录未保存）"
              : result.error + "；离线队列写入失败，记录未保存",
      };
    }
    return { ...result, queued: true };
  }

  /**
   * 上传待办。同一 operationId（同一待办）：
   * - 同页并发调用共享同一次执行（single-flight）；
   * - 跨页靠 Web Lock 原子互斥，另一页正在上传时直接返回 BUSY；
   * - 审查四④：没有可靠跨页锁（且不是单 WebView 的 App）时不提交，返回可重试的 LOCK_UNAVAILABLE。
   *   不再用 localStorage 租约兜底（写后回读不是原子操作）。
   */
  function pushTodo(opts) {
    const opHint =
      (opts && opts.operationId) ||
      (opts && opts.todoId ? stableTodoOperationId(opts.todoId) : null);
    const operationId = newOpId(opHint);
    const running = pushInflight.get(operationId);
    if (running) return running;
    const busy = () => ({
      ok: false,
      code: "BUSY",
      error: "另一个页面正在上传这条待办，请稍后再看",
      retryable: true,
      operationId,
    });
    // 「查询 → 创建 → 确认落盘」整段持有锁（原子、跨页面、崩溃自动释放）
    const p = withLockIfAvailable(
      "push:" + operationId,
      () => pushTodoImpl(opts, operationId, operationId === opHint),
      busy,
      () => lockUnavailableResult(operationId)
    );
    pushInflight.set(operationId, p);
    p.finally(() => {
      if (pushInflight.get(operationId) === p) pushInflight.delete(operationId);
    }).catch(() => {});
    return p;
  }

  async function pushTodoImpl(opts, operationId, stableOp) {
    const clean = cleanTaskTitle(opts && opts.title);
    if (!clean) return { ok: false, code: "BAD_ARGS", error: "标题为空", retryable: false };

    const token = await readToken();
    if (!token) {
      return {
        ok: false,
        code: "NO_TOKEN",
        error: "没找到 ClickUp token。请在设置里粘贴 pk_… 密钥。",
        retryable: false,
      };
    }

    const marker = opMarker(operationId);
    const manualRetry = Boolean(opts && opts.manualRetry);
    const pendingPush = readPendingPushes().find((x) => x.operationId === operationId) || null;
    const hadPending = Boolean(pendingPush);
    const meta = { title: clean, priority: opts && opts.priority, dueDate: opts && opts.dueDate };
    const recovered = async (taskId, rawUrl, extra) => {
      const url = safeClickUpTaskUrl(rawUrl, taskId);
      taskCache.set(normTitle(clean), { id: taskId, at: Date.now() });
      await settleCreatedPush(operationId, taskId, url, meta);
      return {
        ok: true,
        taskId,
        url,
        name: clean,
        recovered: true,
        operationId,
        scheduleDay: resolveTaskSchedule(opts && opts.dueDate)?.day || null,
        scheduleDefaulted: !isRealISODate(opts && opts.dueDate),
        ...extra,
      };
    };

    // 本机已确认创建过：直接复用，不发请求
    const pushed = stableOp ? findPushedRecord(operationId) : null;
    if (pushed) return recovered(pushed.taskId, pushed.url, { localRecord: true });
    // 远端创建成功但「已创建」缓存没写进去：taskId 留在 pending 里，同样直接复用
    if (pendingPush && isClickUpTaskId(pendingPush.taskId)) {
      return recovered(pendingPush.taskId, pendingPush.url, { localRecord: true });
    }

    // 稳定 id（同一待办）或曾提交过（pending）或显式恢复：先按 marker 查，避免重复创建
    if (stableOp || hadPending || opts?.recoverOnly) {
      let found = null;
      try {
        found = await findTaskByOpMarker(token, operationId);
      } catch {
        // 查询结果不确定：无论是否有 pending 都不 POST（本地记录可能已丢，远端也许早就有了）
        if (hadPending || opts?.recoverOnly) {
          return {
            ok: false,
            code: "INDETERMINATE",
            error: "无法查询 ClickUp 是否已创建任务，暂不重复提交",
            retryable: false,
            operationId,
          };
        }
        return {
          ok: false,
          code: "LOOKUP_FAILED",
          error: "暂时无法确认 ClickUp 里是否已有这条任务，为避免重复创建本次未提交，请稍后重试",
          retryable: true,
          operationId,
        };
      }
      if (found && found.id) return recovered(String(found.id), found.url);
      if (opts?.recoverOnly) {
        return {
          ok: false,
          code: "NOT_FOUND",
          error: "未找到对应的 ClickUp 任务",
          retryable: true,
          operationId,
        };
      }
      // pending 但查无：上次的 POST 可能稍后才落库。宽限期内静默等待；
      // 宽限期过后也不自动重建（一次空查询证明不了原请求不会再提交），交给用户手动重试
      if (hadPending) {
        const createdAt = Number(pendingPush.createdAt);
        const age = Number.isFinite(createdAt) && createdAt > 0 ? Date.now() - createdAt : 0;
        if (age < LIMITS.pendingRequeueGraceMs) {
          return {
            ok: false,
            code: "INDETERMINATE",
            error: "上次创建结果尚未确认，稍后会自动核对，不会重复创建",
            retryable: false,
            operationId,
          };
        }
        if (!manualRetry) {
          await markPendingPushManual(operationId);
          return {
            ok: false,
            code: "NEEDS_MANUAL_RETRY",
            error: "上次上传长时间未确认（ClickUp 暂未查到），已停止自动重建；确认 ClickUp 里没有这条任务后可手动重新上传",
            retryable: false,
            needsManual: true,
            operationId,
          };
        }
        // 用户确认手动重试，且刚才的查询明确为空：允许再 POST（仍带同一 marker）
      }
    }

    try {
      const userId = await getSelfUserId(token);
      const assigneeNum = Number(userId);
      if (!Number.isFinite(assigneeNum) || assigneeNum <= 0) {
        return {
          ok: false,
          code: "REQUEST_FAILED",
          error: "当前用户 id 无效，无法指派到 My Work",
          retryable: true,
        };
      }
      const schedule = resolveTaskSchedule(opts && opts.dueDate);
      const body = {
        name: clean,
        assignees: [assigneeNum],
        description:
          "从 Lumina Todo 快捷上传 · " + dayLabel(Date.now()) + "\n" + marker,
      };
      const prio = mapPriority(opts && opts.priority);
      if (prio) body.priority = prio;
      if (schedule) {
        body.start_date = schedule.startMs;
        body.start_date_time = false;
        body.due_date = schedule.dueMs;
        body.due_date_time = false;
      }

      if (!(await upsertPendingPush({
        operationId,
        title: clean,
        priority: opts && opts.priority,
        dueDate: opts && opts.dueDate,
        state: "indeterminate",
      }))) {
        const full = readPendingPushes().filter((x) => x.operationId !== operationId).length >= MAX_PENDING;
        return {
          ok: false,
          code: full ? "PENDING_FULL" : "PENDING_WRITE_FAILED",
          error: full
            ? "待核对的上传过多，请稍后再试（已暂停提交以避免重复创建）"
            : "无法保存创建任务的恢复记录，已取消提交以避免重复创建",
          retryable: full,
          operationId,
        };
      }

      let made;
      try {
        made = await cu(token, "POST", "/list/" + listId() + "/task", body);
      } catch (err) {
        // POST 已发出：除明确拒绝（完整 4xx）外（Failed to fetch、正文读取/解析失败、超时、5xx）
        // 结果都未知 → 保留 pending 并查询 marker
        if (!isDefiniteRejection(err)) {
          try {
            const found = await findTaskByOpMarker(token, operationId);
            if (found && found.id) return recovered(String(found.id), found.url);
            // 暂时查无 ≠ 没写上：迟到的提交可能稍后落库。保留 pending，
            // 由对账（reconcilePendingPushes / 下次上传预查）确认，不自动重建
            return {
              ok: false,
              code: "INDETERMINATE",
              error:
                redactSecrets(String(err.message || err)).slice(0, 200) +
                "；创建结果尚未确认，稍后会自动核对，不会重复创建",
              retryable: false,
              operationId,
            };
          } catch {
            return {
              ok: false,
              code: "INDETERMINATE",
              error: "创建结果未知且无法查询，稍后会自动核对（不会重复提交）",
              retryable: false,
              operationId,
            };
          }
        }
        await clearPendingPush(operationId);
        throw err;
      }

      if (!made || !made.id) {
        // 2xx 却没有 id：远端可能已建，保留 pending 交给 marker 对账，不清除
        return {
          ok: false,
          code: "INDETERMINATE",
          error: "创建任务未返回 id，稍后会自动核对，不会重复创建",
          retryable: false,
          operationId,
        };
      }
      const taskId = String(made.id);
      const url = safeClickUpTaskUrl(made.url, taskId);
      taskCache.set(normTitle(clean), { id: taskId, at: Date.now() });
      // 「已创建」记录可靠落盘后才清 pending；写失败时 taskId 留在 pending，重传直接复用
      const durable = await settleCreatedPush(operationId, taskId, url, meta);
      return {
        ok: true,
        taskId,
        url,
        name: clean,
        operationId,
        scheduleDay: schedule?.day || null,
        scheduleDefaulted: !isRealISODate(opts && opts.dueDate),
        ...(durable ? {} : { recordPending: true }),
      };
    } catch (err) {
      return {
        ok: false,
        code: isTimeoutError(err) ? "TIMEOUT" : "REQUEST_FAILED",
        error: redactSecrets(String((err && err.message) || err)).slice(0, 300),
        retryable: err && err.retryable === false ? false : true,
        operationId,
      };
    }
  }

  async function flushQueueImpl() {
    let q = readQueue();
    if (!q.length) return { flushed: 0, left: 0 };
    // 缺凭证时整个队列暂停：记录原样留着，等用户重新配置 token 后（setStoredToken）再补传
    let token = null;
    try {
      token = await readToken();
    } catch {
      token = null;
    }
    if (!token) return { flushed: 0, left: q.length, paused: "NO_TOKEN" };
    // 写探测（也把缺 queueId/operationId 的旧记录固化下来）
    const probe = await mutateQueue(() => true);
    if (!probe.ok) {
      return { flushed: 0, left: readQueue().length, error: probe.lock ? "LOCK_UNAVAILABLE" : "QUEUE_WRITE_FAILED" };
    }
    q = probe.q;
    let flushed = 0;
    /** 队列写失败时如实报告「盘上真实剩余」（审查四⑥：别用已在内存里删掉一项的数组算） */
    const writeFail = (res) => ({
      flushed,
      left: readQueue().length,
      error: res && res.lock ? "LOCK_UNAVAILABLE" : "QUEUE_WRITE_FAILED",
    });
    while (q.length) {
      const item = q[0];
      const queueId = item.queueId;
      const r = await logPomodoro({
        title: item.title,
        taskId: item.taskId || undefined,
        minutes: item.minutes,
        endedAt: item.endedAt,
        operationId: item.operationId,
        __noQueue: true,
      });

      q = readQueue();
      const index = q.findIndex((x) => x.queueId === queueId);
      if (index < 0) continue;

      if (r.ok) {
        // 审查四⑥：队列项移除与「已确认」回执清除在同一 store 临界区内完成；
        // 队列写失败时回执保留，下一轮直接按回执判成功，不会因远端暂不可见而重 POST
        const res = await mutateQueue((qq) => {
          const i = qq.findIndex((x) => x.queueId === queueId);
          if (i < 0) return "gone";
          const op = qq[i].operationId;
          qq.splice(i, 1);
          return op;
        });
        if (!res.ok) return writeFail(res);
        const op = res.value;
        if (op && op !== "gone" && !res.q.some((x) => x.operationId === op)) {
          await mutateStore(() => {
            const list = readPendingPomos();
            const cur = list.find((x) => x.operationId === op);
            if (!isConfirmedPomo(cur)) return true;
            return writePendingPomos(list.filter((x) => x !== cur));
          });
        }
        q = res.q;
        flushed++;
        continue;
      }
      // INDETERMINATE：保留队列项但不增加 tries 的盲目重 POST；等下次能查询时 dedupe
      // PENDING_FULL：待核对记录满了，等对账消化后再发
      // TASK_INDETERMINATE：新建任务结果未知，只对账不重建（审查四⑦）
      // LOCK_UNAVAILABLE：没有可靠跨页锁，暂停
      if (
        r.code === "INDETERMINATE" ||
        r.code === "PENDING_FULL" ||
        r.code === "TASK_INDETERMINATE" ||
        r.code === "LOCK_UNAVAILABLE"
      ) {
        break;
      }
      // 长时间未确认：待核对记录（含完整打卡信息）接管这条，等用户手动重试；
      // 队列项移除，免得它把后面的记录永远堵住
      if (r.code === "NEEDS_MANUAL_RETRY") {
        const res = await mutateQueue((qq) => {
          const i = qq.findIndex((x) => x.queueId === queueId);
          if (i >= 0) qq.splice(i, 1);
        });
        if (!res.ok) return writeFail(res);
        q = res.q;
        continue;
      }
      // 凭证缺失/失效不是这条记录的错：整队暂停，不消耗重试次数、不移入失败记录
      if (r.code === "NO_TOKEN" || r.code === "HTTP_401") {
        return { flushed, left: q.length, paused: r.code };
      }
      if (!r.retryable || (item.tries || 0) >= MAX_TRIES) {
        const res = await mutateStore(() => {
          const qq = readQueue();
          const i = qq.findIndex((x) => x.queueId === queueId);
          if (i < 0) return { ok: true, q: qq };
          if (!recordFailedSync(qq[i], r)) return { ok: false, failed: true, q: qq };
          qq.splice(i, 1);
          if (!writeQueue(qq)) return { ok: false, q: qq };
          return { ok: true, q: qq };
        }, { ok: false, lock: true });
        if (!res.ok) {
          if (res.failed) return { flushed, left: readQueue().length, error: "FAILED_QUEUE_WRITE_FAILED" };
          return writeFail(res);
        }
        q = res.q;
        continue;
      }
      const res = await mutateQueue((qq) => {
        const i = qq.findIndex((x) => x.queueId === queueId);
        if (i >= 0) qq[i].tries = (qq[i].tries || 0) + 1;
      });
      if (!res.ok) return writeFail(res);
      q = res.q;
      break;
    }
    return { flushed, left: q.length };
  }

  function countManual(list) {
    return list.filter((x) => x && x.needsManual).length;
  }
  /** 需要用户处理/仍待核对的打卡（不含「已确认」回执） */
  function openPendingPomos() {
    return readPendingPomos().filter((x) => !isConfirmedPomo(x));
  }

  /**
   * Uncertain time-entry posts are never replayed automatically. Each pass
   * looks the marker up again: a hit clears the record; a miss after the grace
   * period only flags it for the user (an empty lookup does not prove the
   * original request will never commit). A failed lookup leaves everything untouched.
   */
  async function reconcilePendingPomos() {
    try {
      return await withLock("pomo-pending", reconcilePendingPomosImpl);
    } catch (err) {
      if (!isLockUnavailable(err)) throw err;
      const left = openPendingPomos();
      return { reconciled: 0, requeued: 0, needsManual: countManual(left), left: left.length, code: "LOCK_UNAVAILABLE" };
    }
  }
  async function reconcilePendingPomosImpl() {
    // 「已确认」回执：队列里已没有对应补发项的直接清掉（队列移除成功后清回执失败的残留）
    await mutateStore(() => {
      const list = readPendingPomos();
      const queued = new Set(readQueue().map((x) => x.operationId));
      const next = list.filter((x) => !(isConfirmedPomo(x) && !queued.has(x.operationId)));
      return next.length === list.length ? true : writePendingPomos(next);
    });
    const token = await readToken();
    if (!token) {
      const list = openPendingPomos();
      return { reconciled: 0, requeued: 0, needsManual: countManual(list), left: list.length };
    }
    let reconciled = 0;
    for (const pending of openPendingPomos()) {
      try {
        const hit = await findTimeEntryByOpMarker(
          token,
          pending.start,
          pending.duration,
          pending.operationId
        );
        if (hit) {
          await confirmPomo(pending.operationId, hit.task?.id);   // 远端已有这条：任何版本的 pending 都可了结
          reconciled++;
        } else if (
          Date.now() - (Number(pending.createdAt) || Date.now()) >= LIMITS.pendingRequeueGraceMs
        ) {
          await markPendingPomoManual(pending.operationId);
        }
      } catch {
        break;
      }
    }
    const left = openPendingPomos();
    return { reconciled, requeued: 0, needsManual: countManual(left), left: left.length };
  }

  /**
   * 用户手动重试长时间未确认的打卡：再查一次 marker，查到就清掉；明确查无才按原
   * operationId 转入补发队列并立即补传。查询失败什么都不动。
   * operationIds 省略时处理所有已过宽限期的待核对记录。
   * 审查四⑨：single-flight 只合并「同一组过滤条件」的重叠调用；不同过滤条件各自排队
   * （都在 pomo-pending 锁上串行），不会被吞掉。
   */
  const retryPendingInflight = new Map();
  function retryFilterKey(operationIds) {
    if (!Array.isArray(operationIds) || !operationIds.length) return "*";
    return JSON.stringify(Array.from(new Set(operationIds.map(String))).sort());
  }
  function retryPendingPomos(operationIds) {
    const key = retryFilterKey(operationIds);
    const running = retryPendingInflight.get(key);
    if (running) return running;
    const p = withLock("pomo-pending", () => retryPendingPomosImpl(operationIds)).catch((err) => {
      if (!isLockUnavailable(err)) throw err;
      const left = openPendingPomos();
      return { ok: false, code: "LOCK_UNAVAILABLE", reconciled: 0, requeued: 0, needsManual: countManual(left), left: left.length };
    });
    retryPendingInflight.set(key, p);
    p.finally(() => {
      if (retryPendingInflight.get(key) === p) retryPendingInflight.delete(key);
    }).catch(() => {});
    return p;
  }
  /** 在 "pomo-pending" 锁内执行：与自动对账、队列补发、别页的手动重试互斥 */
  async function retryPendingPomosImpl(operationIds) {
    const token = await readToken();
    const only = Array.isArray(operationIds) && operationIds.length ? new Set(operationIds) : null;
    if (!token) return { ok: false, code: "NO_TOKEN", reconciled: 0, requeued: 0, left: openPendingPomos().length };
    let reconciled = 0;
    let requeued = 0;
    let error = null;
    // 审查四⑦：用户手动重试时一并处理「新建任务结果未知」的记录：查到就采用；
    // 过了宽限期且明确查无，才在用户授权下放行重新创建
    if (!only) {
      for (const pt of readPendingTasks()) {
        const aged = Date.now() - (Number(pt.createdAt) || 0) >= LIMITS.pendingRequeueGraceMs;
        if (!pt.needsManual && !aged) continue;
        let found;
        try {
          found = await findTaskByOpMarker(token, pt.operationId);
        } catch {
          error = "LOOKUP_FAILED";
          break;
        }
        if (found && found.id) taskCache.set(pt.key, { id: String(found.id), at: Date.now() });
        await clearPendingTask(pt.key, pt.operationId);
        reconciled += found && found.id ? 1 : 0;
        requeued += found && found.id ? 0 : 1;   // 队列里等着它的打卡随后的 flush 会重新建任务
      }
    }
    for (const listed of error ? [] : openPendingPomos()) {
      if (only && !only.has(listed.operationId)) continue;
      // 每条都按最新存储重新读取：之前的 await 期间它可能已被别的流程改写
      const pending = currentPendingPomo(listed.operationId);
      if (!pending || isConfirmedPomo(pending)) continue;
      const aged = Date.now() - (Number(pending.createdAt) || Date.now()) >= LIMITS.pendingRequeueGraceMs;
      if (!pending.needsManual && !aged) continue;
      let hit;
      try {
        hit = await findTimeEntryByOpMarker(token, pending.start, pending.duration, pending.operationId);
      } catch {
        error = "LOOKUP_FAILED";
        break;
      }
      if (hit) {
        await confirmPomo(pending.operationId, hit.task?.id);
        reconciled++;
        continue;
      }
      const r = await requeuePendingPomo(pending);   // compare-and-clear：版本变了就跳过
      if (r === "stale") continue;
      if (r) requeued++;
      else {
        error = "QUEUE_WRITE_FAILED";
        break;
      }
    }
    let flush = null;
    if (requeued) {
      try {
        flush = await flushQueueImpl();   // 已持有 pomo-pending 锁：直接跑实现，不能再请求同名锁
      } catch {
        flush = null;
      }
    }
    const left = openPendingPomos();
    return { ok: !error, code: error, reconciled, requeued, flush, needsManual: countManual(left), left: left.length };
  }

  /**
   * 不确定的创建请求持续对账：查到 marker 就记为已创建（App 再传时直接复用），
   * 查无则保留 pending 继续对账，过了宽限期标记为需手动处理（不自动重建）；查询失败什么都不动。
   */
  async function reconcilePendingPushes() {
    const token = await readToken();
    const list = readPendingPushes();
    if (!token || !list.length) return { reconciled: 0, left: list.length };
    let reconciled = 0;
    let lockMissing = false;
    for (const pending of list) {
      // 正在上传（本页 single-flight 或别页持锁）的条目由上传流程自己收尾，对账跳过
      if (pushInflight.has(pending.operationId)) continue;
      let busy = false;
      const stop = await withLockIfAvailable(
        "push:" + pending.operationId,
        () => reconcileOnePush(token, pending).then((r) => {
          if (r === "reconciled") reconciled++;
          return r === "stop";
        }),
        () => {
          busy = true;
          return false;
        },
        () => {
          lockMissing = true;
          return true;
        }
      );
      if (busy) continue;
      if (stop) break;
    }
    const left = readPendingPushes();
    return { reconciled, needsManual: countManual(left), left: left.length, ...(lockMissing ? { code: "LOCK_UNAVAILABLE" } : {}) };
  }
  async function reconcileOnePush(token, listed) {
    const pending = readPendingPushes().find((x) => x.operationId === listed.operationId);
    if (!pending) return "skip";
    // 已知 taskId（只差「已创建」记录落盘）：重试落盘，不查不建
    if (isClickUpTaskId(pending.taskId)) {
      return (await settleCreatedPush(pending.operationId, pending.taskId, pending.url)) ? "reconciled" : "skip";
    }
    try {
      const found = await findTaskByOpMarker(token, pending.operationId);
      if (found && found.id) {
        const taskId = String(found.id);
        await settleCreatedPush(pending.operationId, taskId, safeClickUpTaskUrl(found.url, taskId));
        return "reconciled";
      }
      if (Date.now() - (Number(pending.createdAt) || Date.now()) >= LIMITS.pendingRequeueGraceMs) {
        await markPendingPushManual(pending.operationId);
      }
      return "skip";
    } catch {
      return "stop";
    }
  }

  function flushQueue() {
    if (flushPromise) return flushPromise;
    // 与自动对账、手动重试共用 pomo-pending 锁：补发与「清除待核对」绝不交错
    flushPromise = withLock("pomo-pending", flushQueueImpl)
      .catch((err) => {
        if (!isLockUnavailable(err)) throw err;
        return { flushed: 0, left: readQueue().length, paused: "LOCK_UNAVAILABLE" };
      })
      .finally(() => {
        flushPromise = null;
      });
    return flushPromise;
  }

  async function status() {
    let t = null;
    let storageError = null;
    try {
      t = await readToken({ refresh: true });
    } catch (err) {
      storageError = err;
    }
    return {
      ok: Boolean(t),
      hasToken: Boolean(t),
      error: storageError?.message || null,
      code: storageError?.code || null,
      queue: readQueue().length,
      failed: readFailedQueue().length,
      pendingPush: readPendingPushes().length,
      pendingPomo: openPendingPomos().length,
      pendingTask: readPendingTasks().length,
      pendingManual:
        countManual(readPendingPushes()) + countManual(openPendingPomos()) + countManual(readPendingTasks()),
      lockMode: lockManager() ? "web-locks" : singleWebView() ? "single-webview" : "unavailable",
      queueCorrupt: Boolean(storeGet(CORRUPT_QUEUE_KEY)),
      secureBackend: secure()?.backend?.() || "localStorage",
    };
  }

  // 预热 token 迁移和恢复连接后的补发都不阻塞启动。
  function reconcileAndFlush() {
    return reconcilePendingPomos()
      .then(() => reconcilePendingPushes().catch(() => {}))
      .then(() => flushQueue());
  }
  ensureTokenMigrated().then(() => reconcileAndFlush()).catch(() => {});
  root.addEventListener?.("online", () => reconcileAndFlush().catch(() => {}));
  root.addEventListener?.("lumina:foreground", () => reconcileAndFlush().catch(() => {}));

  root.LUMINA_MOBILE_CLICKUP = {
    logPomodoro,
    pushTodo,
    flushQueue,
    retryFailedQueue,
    clearFailedQueue,
    reconcilePendingPomos,
    reconcilePendingPushes,
    retryPendingPomos,
    setStoredToken,
    getStoredToken,
    status,
    readToken,
    // 测试/调试
    _opMarker: opMarker,
    _extractOpId: extractOpId,
    _stableTodoOperationId: stableTodoOperationId,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
