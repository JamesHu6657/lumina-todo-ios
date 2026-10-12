/**
 * ClickUp 桥（浏览器 / iOS WebView 版）
 * - token 优先 Keychain（LuminaSecureStore），回退 localStorage
 * - 队列落 localStorage；创建任务/时间记录带 [lumina-op:…] 幂等标记
 * - flush 单飞；超时先查询再决定是否重试
 * - 结果不确定的提交只做 marker 对账，不自动重建/补发；长时间未确认交给用户手动重试
 * - 同一待办的上传：同页 single-flight + 跨页 localStorage 租约
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
  // 跨标签页的上传租约：同一 operationId 同时只允许一个页面做「查询→创建→落盘」
  const PUSH_LEASE_PREFIX = "lumina-cu-push-lease-v1:";
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
    // 上传租约有效期：覆盖查询 + 创建（单次请求 15s 截止）+ 落盘，页面崩溃后自动过期
    pushLeaseMs: 2 * 60 * 1000,
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
  // 本页标识：跨标签页上传租约的持有者
  const PAGE_ID = newId("page-");

  /* ----------------------------- 互斥 ----------------------------- */
  /**
   * 跨页面原子互斥：优先 Web Locks（navigator.locks，iOS WKWebView 15.4+ 支持）。
   * 锁由浏览器在所有同源页面间仲裁，持有页崩溃/关闭时自动释放，不存在
   * 「两页同时读到空锁再各自写入」的窗口。不支持时退回本页内互斥（push 另有
   * localStorage 租约兜底）。
   */
  function lockManager() {
    try {
      const lm = root.navigator && root.navigator.locks;
      return lm && typeof lm.request === "function" ? lm : null;
    } catch {
      return null;
    }
  }
  const LOCK_PREFIX = "lumina-clickup:";
  const pageLockTails = new Map();
  /** 排队等待的互斥（本页 FIFO + 跨页 Web Lock）。fn 内绝不能再请求同名锁。 */
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
        if (!lm) return await fn();
        let entered = false;
        try {
          return await lm.request(LOCK_PREFIX + name, { mode: "exclusive" }, () => {
            entered = true;
            return fn();
          });
        } catch (err) {
          // 锁服务本身不可用（SecurityError 等，回调从未进入）：退回本页互斥
          if (!entered) return await fn();
          throw err;
        }
      } finally {
        release();
        if (pageLockTails.get(name) === tail) pageLockTails.delete(name);
      }
    });
  }
  /**
   * 不等待的互斥：锁被（任一页面）占用时立即调用 onBusy。
   * 无 Web Locks 时直接执行 fn（由调用方的租约/本页 single-flight 兜底）。
   */
  async function withLockIfAvailable(name, fn, onBusy) {
    const lm = lockManager();
    if (!lm) return fn(false);
    let entered = false;
    try {
      return await lm.request(LOCK_PREFIX + name, { mode: "exclusive", ifAvailable: true }, (lock) => {
        entered = true;
        return lock ? fn(true) : onBusy();
      });
    } catch (err) {
      if (!entered) return fn(false);   // 锁服务不可用：退回租约 / 本页 single-flight
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
    if (!id) return;
    const sid = String(id);
    for (const [k, v] of taskCache) {
      if (v && v.id === sid) taskCache.delete(k);
    }
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
      const tasks = Array.isArray(listed.tasks) ? listed.tasks : [];
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

  async function ensureTask(token, title, dueTs) {
    const key = normTitle(title);
    const hit = taskCache.get(key);
    if (hit && Date.now() - hit.at < LIMITS.taskCacheMs) return hit.id;
    const pending = ensureInflight.get(key);
    if (pending) return pending;

    const work = (async () => {
      const again = taskCache.get(key);
      if (again && Date.now() - again.at < LIMITS.taskCacheMs) return again.id;
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
        const body = { name: title };
        if (Number.isFinite(dueTs) && dueTs > 0) {
          body.due_date = dueTs;
          body.due_date_time = false;
        }
        const made = await cu(token, "POST", "/list/" + listId() + "/task", body);
        if (!made || !made.id) {
          const err = new Error("ClickUp 创建任务未返回 id");
          err.retryable = true;
          throw err;
        }
        id = String(made.id);
      }
      taskCache.set(key, { id, at: Date.now() });
      return id;
    })();

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
  function writeQueue(arr) {
    return storeSet(QUEUE_KEY, JSON.stringify(arr));
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
  function recordFailed(item, result) {
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
  async function retryFailedQueue({ includeAuth = false } = {}) {
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
  }
  function clearFailedQueue() {
    return writeFailedQueue([]);
  }
  function enqueue(entry) {
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
  function upsertPendingPush(entry) {
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
  function markPendingPushManual(operationId) {
    const list = readPendingPushes();
    const item = list.find((x) => x.operationId === operationId);
    if (!item || item.needsManual) return Boolean(item);
    item.needsManual = true;
    return writePendingPushes(list);
  }
  /**
   * 远端已有 taskId：先可靠写入「已创建」记录，成功后才清 pending；
   * 写失败就把 taskId 留在 pending，下次直接复用，绝不再 POST。
   */
  function settleCreatedPush(operationId, taskId, url, meta) {
    if (rememberPushed(operationId, taskId, url)) {
      clearPendingPush(operationId);
      return true;
    }
    const prev = readPendingPushes().find((x) => x.operationId === operationId) || {};
    upsertPendingPush({
      operationId,
      title: (meta && meta.title) || prev.title || "",
      priority: (meta && meta.priority) || prev.priority || "",
      dueDate: (meta && meta.dueDate) || prev.dueDate || null,
      createdAt: prev.createdAt,
      taskId,
      url,
    });
    return false;
  }
  function clearPendingPush(operationId) {
    const list = readPendingPushes().filter((x) => x.operationId !== operationId);
    return writePendingPushes(list);
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
  function rememberPushed(operationId, taskId, url) {
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
  function pendingPomosFull(operationId) {
    const list = readPendingPomos();
    return list.length >= MAX_PENDING && !list.some((item) => item.operationId === operationId);
  }
  function upsertPendingPomo(entry) {
    const list = readPendingPomos().filter((item) => item.operationId !== entry.operationId);
    if (list.length >= MAX_PENDING) return false;
    // rev：每次写入换新版本号，清除时比对（compare-and-clear），旧快照清不掉新记录
    list.push({ ...entry, createdAt: entry.createdAt || Date.now(), rev: newId("rev-") });
    return writePendingPomos(list);
  }
  function markPendingPomoManual(operationId) {
    const list = readPendingPomos();
    const item = list.find((x) => x.operationId === operationId);
    if (!item || item.needsManual) return Boolean(item);
    item.needsManual = true;
    return writePendingPomos(list);
  }
  function clearPendingPomo(operationId) {
    return writePendingPomos(readPendingPomos().filter((item) => item.operationId !== operationId));
  }
  /** 仅当当前记录仍是 expected 那一版时才清除；返回是否清掉 */
  function clearPendingPomoIf(operationId, expectedRev) {
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
   * 先写队列再清 pending；队列里已有同 operationId 就只清 pending，不重复入队。
   * 补发时 logPomodoro 会再预查一次，预查失败不会 POST。
   */
  function requeuePendingPomo(pending) {
    // compare-and-clear：读到的这一版已被别的流程改写/清除（例如另一次重试已开始
    // POST 并写入新 pending），就什么都不做——旧快照绝不能清掉新记录
    const cur = currentPendingPomo(pending.operationId);
    if (!cur || (cur.rev ?? null) !== (pending.rev ?? null)) return "stale";
    const already = readQueue().some((item) => item.operationId === pending.operationId);
    if (!already && !enqueue({
      title: typeof pending.title === "string" ? pending.title : "",
      taskId: pending.taskId,
      minutes: pending.minutes,
      endedAt: pending.endedAt,
      operationId: pending.operationId,
    })) {
      return false;
    }
    return clearPendingPomoIf(pending.operationId, pending.rev);
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
      const entries = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];
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

  /** A timeout/5xx can be committed remotely after the client loses the reply. */
  async function settleUncertainPomo(token, { start, duration, operationId, taskId, name, minutes, noQueue, cause }) {
    try {
      const hit = await findTimeEntryByOpMarker(token, start, duration, operationId);
      if (hit) {
        clearPendingPomo(operationId);
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

  /**
   * 同一 operationId 的打卡（队列补发、手动重试、别页同段打卡）跨页面串行：
   * 后到者在锁内预查时能看到先到者的结果或 pending，不会两边同时 POST。
   */
  function logPomodoro(opts) {
    const op =
      typeof opts?.operationId === "string" && /^[A-Za-z0-9._:-]{6,80}$/.test(opts.operationId)
        ? opts.operationId
        : null;
    if (!op) return logPomodoroImpl(opts);
    return withLock("pomo-op:" + op, () => logPomodoroImpl(opts));
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
    const operationId = newOpId(callerOpId);
    const noQueue = Boolean(opts && opts.__noQueue);
    const failPayload = (err) => ({
      ok: false,
      code: isTimeoutError(err)
        ? "TIMEOUT"
        : Number.isFinite(err?.status) && err.status >= 400 && err.status < 500
          ? "HTTP_" + err.status
          : "REQUEST_FAILED",
      error: redactSecrets(String((err && err.message) || err)).slice(0, 300),
      retryable: err && err.retryable === false ? false : true,
      operationId,
    });

    // A random id created for a brand-new request cannot be found remotely.
    // Preflight only when the caller supplied a stable retry/idempotency key.
    if (callerOpId) try {
      const existing = await findTimeEntryByOpMarker(token, start, duration, operationId);
      if (existing) {
        clearPendingPomo(operationId);
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
        markPendingPomoManual(operationId);
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
      if (!upsertPendingPomo({
        operationId, title: clean, taskId: knownTaskId, minutes: mins, endedAt, start, duration,
      })) {
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
          forgetTaskId(tid);
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
          clearPendingPomo(operationId);
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
      if (!noQueue) flushQueue().catch(() => {});
      clearPendingPomo(operationId);
      return { ok: true, taskId: tid, name, minutes: mins, operationId };
    } catch (err) {
      if (pendingPomo) clearPendingPomo(operationId);
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
  function enqueuePomoResult(result, entry) {
    const full = readQueue().length >= MAX_QUEUE;
    if (full || !enqueue(entry)) {
      return {
        ...result,
        code: full ? "QUEUE_FULL" : "QUEUE_WRITE_FAILED",
        retryable: false,
        queued: false,
        error: full
          ? result.error + "；离线队列已满（" + MAX_QUEUE + " 条），这条记录未保存"
          : result.error + "；离线队列写入失败，记录未保存",
      };
    }
    return { ...result, queued: true };
  }

  function readPushLease(operationId) {
    try {
      const v = JSON.parse(storeGet(PUSH_LEASE_PREFIX + operationId) || "null");
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  }
  /**
   * 跨标签页租约（localStorage，带过期）：同一 operationId 已被别的页面持有且未过期时拒绝。
   * 写入后回读校验 token，两页同时抢占时至多一方拿到。返回租约 token 或 null。
   * 存储不可用时放行：pending 写不进去，后续本来就会中止提交。
   */
  function acquirePushLease(operationId) {
    const now = Date.now();
    const cur = readPushLease(operationId);
    if (cur && cur.owner !== PAGE_ID && Number(cur.exp) > now) return null;
    const token = newId("lease-");
    if (!storeSet(PUSH_LEASE_PREFIX + operationId, JSON.stringify({ owner: PAGE_ID, token, exp: now + LIMITS.pushLeaseMs }))) {
      return "unstored";
    }
    const back = readPushLease(operationId);
    return back && back.token === token ? token : null;
  }
  function releasePushLease(operationId, token) {
    if (!token || token === "unstored") return;
    const cur = readPushLease(operationId);
    if (cur && cur.token === token) storeRemove(PUSH_LEASE_PREFIX + operationId);
  }

  /**
   * 上传待办。同一 operationId（同一待办）：
   * - 同页并发调用共享同一次执行（single-flight）；
   * - 跨标签页靠 localStorage 租约互斥，另一页正在上传时直接返回 BUSY。
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
    // 「查询 → 创建 → 确认落盘」整段持有 Web Lock（原子、跨页面、崩溃自动释放）；
    // 锁内仍写 localStorage 租约：不支持 Web Locks 的环境靠它兜底，也让旧版本页面看得见
    const p = withLockIfAvailable(
      "push:" + operationId,
      async () => {
        const lease = acquirePushLease(operationId);
        if (!lease) return busy();
        try {
          return await pushTodoImpl(opts, operationId, operationId === opHint);
        } finally {
          releasePushLease(operationId, lease);
        }
      },
      busy
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
    const recovered = (taskId, rawUrl, extra) => {
      const url = safeClickUpTaskUrl(rawUrl, taskId);
      taskCache.set(normTitle(clean), { id: taskId, at: Date.now() });
      settleCreatedPush(operationId, taskId, url, meta);
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
          markPendingPushManual(operationId);
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

      if (!upsertPendingPush({
        operationId,
        title: clean,
        priority: opts && opts.priority,
        dueDate: opts && opts.dueDate,
        state: "indeterminate",
      })) {
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
        clearPendingPush(operationId);
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
      const durable = settleCreatedPush(operationId, taskId, url, meta);
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
    if (!writeQueue(q)) {
      return { flushed: 0, left: q.length, error: "QUEUE_WRITE_FAILED" };
    }
    let flushed = 0;
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
        q.splice(index, 1);
        if (!writeQueue(q)) {
          return { flushed, left: q.length, error: "QUEUE_WRITE_FAILED" };
        }
        flushed++;
        continue;
      }
      // INDETERMINATE：保留队列项但不增加 tries 的盲目重 POST；等下次能查询时 dedupe
      // PENDING_FULL：待核对记录满了，等对账消化后再发
      if (r.code === "INDETERMINATE" || r.code === "PENDING_FULL") {
        break;
      }
      // 长时间未确认：待核对记录（含完整打卡信息）接管这条，等用户手动重试；
      // 队列项移除，免得它把后面的记录永远堵住
      if (r.code === "NEEDS_MANUAL_RETRY") {
        q.splice(index, 1);
        if (!writeQueue(q)) {
          return { flushed, left: q.length, error: "QUEUE_WRITE_FAILED" };
        }
        continue;
      }
      // 凭证缺失/失效不是这条记录的错：整队暂停，不消耗重试次数、不移入失败记录
      if (r.code === "NO_TOKEN" || r.code === "HTTP_401") {
        return { flushed, left: q.length, paused: r.code };
      }
      if (!r.retryable || (item.tries || 0) >= MAX_TRIES) {
        if (!recordFailed(item, r)) {
          return { flushed, left: q.length, error: "FAILED_QUEUE_WRITE_FAILED" };
        }
        q.splice(index, 1);
        if (!writeQueue(q)) {
          return { flushed, left: q.length, error: "QUEUE_WRITE_FAILED" };
        }
        continue;
      }
      q[index].tries = (q[index].tries || 0) + 1;
      if (!writeQueue(q)) {
        return { flushed, left: q.length, error: "QUEUE_WRITE_FAILED" };
      }
      break;
    }
    return { flushed, left: q.length };
  }

  function countManual(list) {
    return list.filter((x) => x && x.needsManual).length;
  }

  /**
   * Uncertain time-entry posts are never replayed automatically. Each pass
   * looks the marker up again: a hit clears the record; a miss after the grace
   * period only flags it for the user (an empty lookup does not prove the
   * original request will never commit). A failed lookup leaves everything untouched.
   */
  function reconcilePendingPomos() {
    return withLock("pomo-pending", reconcilePendingPomosImpl);
  }
  async function reconcilePendingPomosImpl() {
    const token = await readToken();
    if (!token) {
      const list = readPendingPomos();
      return { reconciled: 0, requeued: 0, needsManual: countManual(list), left: list.length };
    }
    let reconciled = 0;
    for (const pending of readPendingPomos()) {
      try {
        const hit = await findTimeEntryByOpMarker(
          token,
          pending.start,
          pending.duration,
          pending.operationId
        );
        if (hit) {
          clearPendingPomo(pending.operationId);   // 远端已有这条：任何版本的 pending 都可清
          reconciled++;
        } else if (
          Date.now() - (Number(pending.createdAt) || Date.now()) >= LIMITS.pendingRequeueGraceMs
        ) {
          markPendingPomoManual(pending.operationId);
        }
      } catch {
        break;
      }
    }
    const left = readPendingPomos();
    return { reconciled, requeued: 0, needsManual: countManual(left), left: left.length };
  }

  /**
   * 用户手动重试长时间未确认的打卡：再查一次 marker，查到就清掉；明确查无才按原
   * operationId 转入补发队列并立即补传。查询失败什么都不动。
   * operationIds 省略时处理所有已过宽限期的待核对记录。
   */
  let retryPendingInflight = null;
  function retryPendingPomos(operationIds) {
    // 本页 single-flight：重叠点击共享同一次执行（不只依赖按钮禁用）
    if (retryPendingInflight) return retryPendingInflight;
    const p = withLock("pomo-pending", () => retryPendingPomosImpl(operationIds));
    retryPendingInflight = p;
    p.finally(() => {
      if (retryPendingInflight === p) retryPendingInflight = null;
    }).catch(() => {});
    return p;
  }
  /** 在 "pomo-pending" 锁内执行：与自动对账、队列补发、别页的手动重试互斥 */
  async function retryPendingPomosImpl(operationIds) {
    const token = await readToken();
    const only = Array.isArray(operationIds) && operationIds.length ? new Set(operationIds) : null;
    if (!token) return { ok: false, code: "NO_TOKEN", reconciled: 0, requeued: 0, left: readPendingPomos().length };
    let reconciled = 0;
    let requeued = 0;
    let error = null;
    for (const listed of readPendingPomos()) {
      if (only && !only.has(listed.operationId)) continue;
      // 每条都按最新存储重新读取：之前的 await 期间它可能已被别的流程改写
      const pending = currentPendingPomo(listed.operationId);
      if (!pending) continue;
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
        clearPendingPomo(pending.operationId);
        reconciled++;
        continue;
      }
      const r = requeuePendingPomo(pending);   // compare-and-clear：版本变了就跳过
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
    const left = readPendingPomos();
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
        }
      );
      if (busy) continue;
      if (stop) break;
    }
    const left = readPendingPushes();
    return { reconciled, needsManual: countManual(left), left: left.length };
  }
  async function reconcileOnePush(token, listed) {
    const pending = readPendingPushes().find((x) => x.operationId === listed.operationId);
    if (!pending) return "skip";
    // 已知 taskId（只差「已创建」记录落盘）：重试落盘，不查不建
    if (isClickUpTaskId(pending.taskId)) {
      return settleCreatedPush(pending.operationId, pending.taskId, pending.url) ? "reconciled" : "skip";
    }
    try {
      const found = await findTaskByOpMarker(token, pending.operationId);
      if (found && found.id) {
        const taskId = String(found.id);
        settleCreatedPush(pending.operationId, taskId, safeClickUpTaskUrl(found.url, taskId));
        return "reconciled";
      }
      if (Date.now() - (Number(pending.createdAt) || Date.now()) >= LIMITS.pendingRequeueGraceMs) {
        markPendingPushManual(pending.operationId);
      }
      return "skip";
    } catch {
      return "stop";
    }
  }

  function flushQueue() {
    if (flushPromise) return flushPromise;
    // 与自动对账、手动重试共用 pomo-pending 锁：补发与「清除待核对」绝不交错
    flushPromise = withLock("pomo-pending", flushQueueImpl).finally(() => {
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
      pendingPomo: readPendingPomos().length,
      pendingManual: countManual(readPendingPushes()) + countManual(readPendingPomos()),
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
