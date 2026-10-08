/**
 * ClickUp 桥（浏览器 / iOS WebView 版）
 * - token 优先 Keychain（LuminaSecureStore），回退 localStorage
 * - 队列落 localStorage；创建任务/时间记录带 [lumina-op:…] 幂等标记
 * - flush 单飞；超时先查询再决定是否重试
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
  const CORRUPT_QUEUE_KEY = "lumina-cu-queue-corrupt-v1";
  const MAX_QUEUE = 200;
  const MAX_FAILED = 50;
  const MAX_TRIES = 5;
  const MAX_LIST_PAGES = 5;
  const OP_RE = /\[lumina-op:([A-Za-z0-9._:-]{6,80})\]/;

  const LIMITS = {
    tokenCacheMs: 5 * 60 * 1000,
    taskCacheMs: 10 * 60 * 1000,
    requestTimeoutMs: 15000,
    maxTitleChars: 200,
    maxPushTitleChars: 500,
    minTokenChars: 20,
    maxMinutes: 180,
    maxResponseChars: 512 * 1024,
    endedAtSkewMs: 60 * 1000,
    // 超时后服务端可能稍晚才落库；确认「没有」至少要隔这么久才转入补发队列
    pendingRequeueGraceMs: 10 * 60 * 1000,
  };

  let tokenCache = { value: null, at: 0 };
  let userIdCache = { value: null, at: 0 };
  const taskCache = new Map();
  const ensureInflight = new Map();
  let flushPromise = null;
  let tokenReady = null;

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
    const p = (async () => {
      const s = secure();
      if (s?.migrateKey) {
        const v = await s.migrateKey(TOKEN_KEY);
        if (isValidToken(v)) {
          tokenCache = { value: v, at: Date.now() };
          return v;
        }
        if (usesKeychain()) {
          tokenCache = { value: null, at: Date.now() };
          return null;
        }
      }
      const raw = (storeGet(TOKEN_KEY) || "").trim();
      const t = isValidToken(raw) ? raw : null;
      tokenCache = { value: t, at: Date.now() };
      return t;
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
      try {
        const v = await s.get(TOKEN_KEY);
        const t = isValidToken(v) ? v : null;
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
        userIdCache = { value: null, at: 0 };
        return { ok: true, backend: "keychain" };
      }
      storeRemove(TOKEN_KEY);
      tokenCache = { value: null, at: 0 };
      userIdCache = { value: null, at: 0 };
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
    tokenCache = { value: t, at: Date.now() };
    retryFailedQueue().then(() => flushQueue()).catch(() => {});
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
    userIdCache = { value: null, at: 0 };
  }

  async function cu(token, method, urlPath, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIMITS.requestTimeoutMs);
    let res;
    let text;
    try {
      res = await fetch(API + urlPath, {
        method,
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      // Keep the same deadline while consuming the body. A peer that sends
      // headers but never finishes its body must not freeze the flush lock.
      let onAbort;
      const timedOut = new Promise((_, reject) => {
        onAbort = () => {
          const err = new Error("ClickUp 请求超时");
          err.name = "AbortError";
          reject(err);
        };
        if (ctrl.signal.aborted) onAbort();
        else ctrl.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        text = await Promise.race([res.text(), timedOut]);
      } finally {
        ctrl.signal.removeEventListener("abort", onAbort);
      }
    } finally {
      clearTimeout(timer);
    }
    if (text.length > LIMITS.maxResponseChars) {
      const err = new Error("ClickUp 响应过大");
      err.status = res.status;
      err.retryable = false;
      throw err;
    }
    if (!res.ok) {
      if (res.status === 401) invalidateToken();
      const err = new Error("ClickUp " + res.status + ": " + redactSecrets(text).slice(0, 200));
      err.status = res.status;
      err.retryable = res.status === 429 || res.status >= 500;
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

  const normTitle = (s) => String(s || "").trim().toLowerCase();

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
      return arr.slice(-MAX_QUEUE).map((item) => ({
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
    return storeSet(QUEUE_KEY, JSON.stringify(arr.slice(-MAX_QUEUE)));
  }
  function readFailedQueue() {
    try {
      const arr = JSON.parse(storeGet(FAILED_QUEUE_KEY) || "[]");
      return Array.isArray(arr) ? arr.slice(-MAX_FAILED) : [];
    } catch {
      return [];
    }
  }
  function writeFailedQueue(arr) {
    return storeSet(FAILED_QUEUE_KEY, JSON.stringify(arr.slice(-MAX_FAILED)));
  }
  function recordFailed(item, result) {
    const failed = readFailedQueue().filter((entry) => entry.queueId !== item.queueId);
    failed.push({
      ...item,
      failedAt: Date.now(),
      failureCode: result?.code || "REQUEST_FAILED",
      failureReason: String(result?.error || "同步失败").slice(0, 300),
      failureRetryable: result?.retryable !== false,
    });
    return writeFailedQueue(failed);
  }
  async function retryFailedQueue() {
    const failed = readFailedQueue();
    if (!failed.length) return { restored: 0, left: 0 };
    const queue = readQueue();
    const ids = new Set(queue.map((entry) => entry.queueId));
    const retryableCodes = new Set(["TIMEOUT", "REQUEST_FAILED", "QUEUE_WRITE_FAILED"]);
    const keep = [];
    const restore = failed
      .filter((entry) => {
        if (ids.has(entry.queueId)) return false;
        if (entry.failureRetryable === false || !retryableCodes.has(entry.failureCode || "REQUEST_FAILED")) {
          keep.push(entry);
          return false;
        }
        return true;
      })
      .map((entry) => ({
        queueId: entry.queueId || newQueueId(),
        operationId: entry.operationId || newOpId(),
        title: entry.title || "",
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
    q.push({
      queueId: newQueueId(),
      operationId: newOpId(entry.operationId),
      title: typeof entry.title === "string" ? entry.title : "",
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
      return Array.isArray(arr) ? arr.slice(-50) : [];
    } catch {
      return [];
    }
  }
  function writePendingPushes(arr) {
    return storeSet(PENDING_PUSH_KEY, JSON.stringify(arr.slice(-50)));
  }
  function upsertPendingPush(entry) {
    const list = readPendingPushes().filter((x) => x.operationId !== entry.operationId);
    list.push({
      operationId: entry.operationId,
      title: entry.title,
      priority: entry.priority || "",
      dueDate: entry.dueDate || null,
      createdAt: entry.createdAt || Date.now(),
      state: entry.state || "indeterminate",
    });
    return writePendingPushes(list);
  }
  function clearPendingPush(operationId) {
    const list = readPendingPushes().filter((x) => x.operationId !== operationId);
    return writePendingPushes(list);
  }

  function readPendingPomos() {
    try {
      const arr = JSON.parse(storeGet(PENDING_POMO_KEY) || "[]");
      return Array.isArray(arr) ? arr.slice(-50) : [];
    } catch {
      return [];
    }
  }
  function writePendingPomos(arr) {
    return storeSet(PENDING_POMO_KEY, JSON.stringify(arr.slice(-50)));
  }
  function upsertPendingPomo(entry) {
    const list = readPendingPomos().filter((item) => item.operationId !== entry.operationId);
    list.push({ ...entry, createdAt: entry.createdAt || Date.now() });
    return writePendingPomos(list);
  }
  function clearPendingPomo(operationId) {
    return writePendingPomos(readPendingPomos().filter((item) => item.operationId !== operationId));
  }
  function hasPendingPomo(operationId) {
    return readPendingPomos().some((item) => item.operationId === operationId);
  }
  /**
   * 查询已确认远端没有这条记录：按原 operationId 转入补发队列。
   * 先写队列再清 pending；队列里已有同 operationId 就只清 pending，不重复入队。
   * 补发时 logPomodoro 会再预查一次，预查失败不会 POST。
   */
  function requeuePendingPomo(pending) {
    const already = readQueue().some((item) => item.operationId === pending.operationId);
    if (!already && !enqueue({
      title: typeof pending.title === "string" ? pending.title : "",
      minutes: pending.minutes,
      endedAt: pending.endedAt,
      operationId: pending.operationId,
    })) {
      return false;
    }
    return clearPendingPomo(pending.operationId);
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
    if (userIdCache.value && now - userIdCache.at < LIMITS.taskCacheMs) return userIdCache.value;
    const data = await cu(token, "GET", "/user");
    const id = data && data.user && data.user.id;
    if (!id && id !== 0) {
      const err = new Error("ClickUp 未返回当前用户 id");
      err.retryable = true;
      throw err;
    }
    userIdCache.value = String(id);
    userIdCache.at = now;
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

  async function logPomodoro(opts) {
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

    const clean = String(title || "").trim().slice(0, LIMITS.maxTitleChars);
    const name = clean || "番茄钟 · " + dayLabel(endedAt);
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
    } catch (err) {
      // A brand-new submission may proceed after a failed preflight. A queued
      // retry or existing pending record must never POST again without proof.
      if (noQueue || hasPendingPomo(operationId)) {
        return settleUncertainPomo(token, {
          start, duration, operationId, taskId: null, name, minutes: mins, noQueue, cause: err,
        });
      }
    }

    let pendingPomo = false;
    try {
      const tid = await ensureTask(token, name, endedAt);
      if (!upsertPendingPomo({ operationId, title: clean, minutes: mins, endedAt, start, duration })) {
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
        if (err && err.status === 404) {
          forgetTaskId(tid);
          taskCache.delete(normTitle(name));
          const tid2 = await ensureTask(token, name, endedAt);
          try {
            await postTimeEntry(token, tid2, start, duration, mins, operationId);
          } catch (retryErr) {
            if (isTimeoutError(retryErr) || (retryErr && retryErr.status >= 500)) {
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
        // 超时/结果未知：先查再决定
        if (isTimeoutError(err) || (err && err.status >= 500)) {
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
        const queued = enqueue({
          title: clean,
          minutes: mins,
          endedAt,
          operationId,
        });
        if (!queued) {
          return {
            ...result,
            code: "QUEUE_WRITE_FAILED",
            retryable: false,
            queued: false,
            error: result.error + "；离线队列写入失败，记录未保存",
          };
        }
        return { ...result, queued: true };
      }
      return result;
    }
  }

  async function pushTodo(opts) {
    const maxLen = LIMITS.maxPushTitleChars;
    const clean = String((opts && opts.title) || "").trim().slice(0, maxLen);
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

    // 稳定 operationId：同待办重试不重复创建
    const operationId = newOpId(
      (opts && opts.operationId) ||
        (opts && opts.todoId ? stableTodoOperationId(opts.todoId) : null)
    );
    const marker = opMarker(operationId);
    const hadPending = readPendingPushes().some((x) => x.operationId === operationId);

    // 曾提交过（pending）或显式恢复：先按 marker 查，避免重复创建
    if (hadPending || opts?.recoverOnly) {
      try {
        const found = await findTaskByOpMarker(token, operationId);
        if (found && found.id) {
          const taskId = String(found.id);
          const url = safeClickUpTaskUrl(found.url, taskId);
          taskCache.set(normTitle(clean), { id: taskId, at: Date.now() });
          clearPendingPush(operationId);
          return {
            ok: true,
            taskId,
            url,
            name: clean,
            recovered: true,
            operationId,
            scheduleDay: resolveTaskSchedule(opts && opts.dueDate)?.day || null,
            scheduleDefaulted: !isRealISODate(opts && opts.dueDate),
          };
        }
        if (opts?.recoverOnly) {
          return {
            ok: false,
            code: "NOT_FOUND",
            error: "未找到对应的 ClickUp 任务",
            retryable: true,
            operationId,
          };
        }
        // pending 但查无：可能上次没写上，允许再 POST
      } catch {
        // 查询失败且已有 pending：不能再盲 POST
        return {
          ok: false,
          code: "INDETERMINATE",
          error: "无法查询 ClickUp 是否已创建任务，暂不重复提交",
          retryable: false,
          operationId,
        };
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
        return {
          ok: false,
          code: "PENDING_WRITE_FAILED",
          error: "无法保存创建任务的恢复记录，已取消提交以避免重复创建",
          retryable: false,
          operationId,
        };
      }

      let made;
      try {
        made = await cu(token, "POST", "/list/" + listId() + "/task", body);
      } catch (err) {
        // 超时/5xx：结果未知 → 查询 marker
        if (isTimeoutError(err) || (err && (err.status >= 500 || err.status === 429))) {
          try {
            const found = await findTaskByOpMarker(token, operationId);
            if (found && found.id) {
              const taskId = String(found.id);
              const url = safeClickUpTaskUrl(found.url, taskId);
              taskCache.set(normTitle(clean), { id: taskId, at: Date.now() });
              clearPendingPush(operationId);
              return {
                ok: true,
                taskId,
                url,
                name: clean,
                recovered: true,
                operationId,
                scheduleDay: schedule?.day || null,
                scheduleDefaulted: !isRealISODate(opts && opts.dueDate),
              };
            }
            // 确认没有 → 可重试
            return {
              ok: false,
              code: isTimeoutError(err) ? "TIMEOUT" : "REQUEST_FAILED",
              error: redactSecrets(String(err.message || err)).slice(0, 300),
              retryable: true,
              operationId,
            };
          } catch {
            return {
              ok: false,
              code: "INDETERMINATE",
              error: "创建结果未知且无法查询，请稍后重试（不会重复提交）",
              retryable: false,
              operationId,
            };
          }
        }
        clearPendingPush(operationId);
        throw err;
      }

      if (!made || !made.id) {
        return {
          ok: false,
          code: "REQUEST_FAILED",
          error: "创建任务未返回 id",
          retryable: true,
          operationId,
        };
      }
      const taskId = String(made.id);
      const url = safeClickUpTaskUrl(made.url, taskId);
      taskCache.set(normTitle(clean), { id: taskId, at: Date.now() });
      clearPendingPush(operationId);
      return {
        ok: true,
        taskId,
        url,
        name: clean,
        operationId,
        scheduleDay: schedule?.day || null,
        scheduleDefaulted: !isRealISODate(opts && opts.dueDate),
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
    if (!writeQueue(q)) {
      return { flushed: 0, left: q.length, error: "QUEUE_WRITE_FAILED" };
    }
    let flushed = 0;
    while (q.length) {
      const item = q[0];
      const queueId = item.queueId;
      const r = await logPomodoro({
        title: item.title,
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
      if (r.code === "INDETERMINATE") {
        break;
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

  /**
   * Uncertain time-entry posts are never blindly replayed: a record is only
   * re-queued after a successful lookup proves it is absent, and only once the
   * grace period has passed. A failed lookup leaves everything untouched.
   */
  async function reconcilePendingPomos() {
    const token = await readToken();
    if (!token) return { reconciled: 0, requeued: 0, left: readPendingPomos().length };
    let reconciled = 0;
    let requeued = 0;
    for (const pending of readPendingPomos()) {
      try {
        const hit = await findTimeEntryByOpMarker(
          token,
          pending.start,
          pending.duration,
          pending.operationId
        );
        if (hit) {
          clearPendingPomo(pending.operationId);
          reconciled++;
        } else if (
          Date.now() - (Number(pending.createdAt) || Date.now()) >= LIMITS.pendingRequeueGraceMs &&
          requeuePendingPomo(pending)
        ) {
          requeued++;
        }
      } catch {
        break;
      }
    }
    return { reconciled, requeued, left: readPendingPomos().length };
  }

  function flushQueue() {
    if (flushPromise) return flushPromise;
    flushPromise = flushQueueImpl().finally(() => {
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
      queueCorrupt: Boolean(storeGet(CORRUPT_QUEUE_KEY)),
      secureBackend: secure()?.backend?.() || "localStorage",
    };
  }

  // 预热 token 迁移和恢复连接后的补发都不阻塞启动。
  function reconcileAndFlush() {
    return reconcilePendingPomos().then(() => flushQueue());
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
