/**
 * iOS / 浏览器端 AI 桥：暴露与 Electron preload 同形的 window.luminaAI / luminaClickUp。
 * API Key 存 localStorage（设置面板写入）；流式用 fetch + ReadableStream。
 */
(function () {
  "use strict";

  /**
   * 支持的 AI 服务商（都是 OpenAI Chat Completions 兼容端点）。
   * 每个服务商有自己的模型、key 存储位与提示文案；切换不会清掉别家的 key。
   */
  const AI_PROVIDERS = {
    opencode: {
      id: "opencode",
      label: "OpenCode Zen",
      base: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4-flash",
      models: ["deepseek-v4-flash"],
      keyStore: "lumina-api-key",
      keyHint: "sk-…",
      keyPattern: /^sk-/,
    },
    commandcode: {
      id: "commandcode",
      label: "Command Code",
      base: "https://api.commandcode.ai/provider/v1",
      model: "deepseek/deepseek-v4.1-flash",
      // Claude 系列只走 Anthropic /messages 接口（官方文档），claude-* 自动切换协议
      anthropic: true,
      models: [
        "claude-sonnet-5-5|Claude Sonnet 5.5",
        "claude-sonnet-5|Claude Sonnet 5",
        "claude-sonnet-4-6|Claude Sonnet 4.6",
        "claude-fable-5-1|Claude Fable 5.1",
        "claude-fable-5|Claude Fable 5",
        "claude-opus-5-5|Claude Opus 5.5",
        "claude-opus-5|Claude Opus 5",
        "claude-opus-4-8|Claude Opus 4.8",
        "claude-opus-4-7|Claude Opus 4.7",
        "claude-haiku-5-5|Claude Haiku 5.5",
        "claude-haiku-4-5-20251001|Claude Haiku 4.5",
        "gpt-6-astra|GPT-6 Astra",
        "gpt-6.1-sol|GPT-6.1 Sol",
        "gpt-6-sol|GPT-6 Sol",
        "gpt-6-luna|GPT-6 Luna",
        "gpt-5.6-sol|GPT-5.6 Sol",
        "gpt-5.6-terra|GPT-5.6 Terra",
        "gpt-5.6-luna|GPT-5.6 Luna",
        "gpt-5.5|GPT-5.5",
        "gpt-5.4|GPT-5.4",
        "gpt-5.3-codex|GPT-5.3 Codex",
        "gpt-5.4-mini|GPT-5.4 Mini",
        "deepseek/deepseek-v4-pro|DeepSeek V4 Pro (latest)",
        "deepseek/deepseek-v4-flash|DeepSeek V4 Flash (latest)",
        "deepseek/deepseek-v4-flash-vision-exp|DeepSeek V4 Flash Vision (exp)",
        "deepseek/deepseek-v4-flash-fast|DeepSeek V4 Flash Fast",
        "deepseek/deepseek-v4.1-flash|DeepSeek V4.1 Flash",
        "deepseek/deepseek-v4.1-flash-fast|DeepSeek V4.1 Flash Fast",
        "moonshotai/Kimi-K3|Kimi K3",
        "moonshotai/Kimi-K2.7-Code|Kimi K2.7 Code",
        "moonshotai/Kimi-K2.7-Code-Highspeed|Kimi K2.7 Code HighSpeed",
        "moonshotai/Kimi-K2.6|Kimi K2.6",
        "moonshotai/Kimi-K2.5|Kimi K2.5",
        "z-ai/glm-5.3-flash|GLM-5.3 Flash",
        "z-ai/glm-5.3-flashx|GLM-5.3 FlashX",
        "zai-org/GLM-5.3|GLM-5.3",
        "zai-org/GLM-5.2|GLM-5.2",
        "zai-org/GLM-5.2-Fast|GLM-5.2 Fast",
        "zai-org/GLM-5.1|GLM-5.1",
        "zai-org/GLM-5|GLM-5",
        "MiniMaxAI/MiniMax-M3|MiniMax M3",
        "MiniMaxAI/MiniMax-M2.7|MiniMax M2.7",
        "MiniMaxAI/MiniMax-M2.5|MiniMax M2.5",
        "xiaomi/mimo-v2.6-pro|MiMo V2.6 Pro",
        "xiaomi/mimo-v2.6-pro-ultraspeed|MiMo V2.6 Pro UltraSpeed",
        "xiaomi/mimo-v2.6-flash|MiMo V2.6 Flash",
        "xiaomi/mimo-v2.5-pro|MiMo V2.5 Pro",
        "xiaomi/mimo-v2.5|MiMo V2.5",
        "Qwen/Qwen3.8-Omni-Flash|Qwen 3.8 Omni Flash",
        "Qwen/Qwen3.8-Max-0902|Qwen 3.8 Max 0902",
        "Qwen/Qwen3.8-Max|Qwen 3.8 Max",
        "Qwen/Qwen3.8-27B|Qwen 3.8 27B",
        "Qwen/Qwen3.8-Flash|Qwen 3.8 Flash",
        "Qwen/Qwen3.7-Max|Qwen 3.7 Max",
        "Qwen/Qwen3.7-Plus|Qwen 3.7 Plus",
        "Qwen/Qwen3.7-Flash|Qwen 3.7 Flash",
        "Qwen/Qwen3.6-Max-Preview|Qwen 3.6 Max Preview",
        "Qwen/Qwen3.6-Plus|Qwen 3.6 Plus",
        "meituan/LongCat-2.0|LongCat 2.0",
        "stepfun/Step-5-Preview|Step 5 Preview",
        "stepfun/Step-3.7-Flash|Step 3.7 Flash",
        "stepfun/Step-3.5-Flash|Step 3.5 Flash",
        "tencent/hy3-paid|Tencent Hy3",
        "tencent/hy4-preview|Tencent Hy4 Preview",
        "google/gemini-3.8-flash|Gemini 3.8 Flash",
        "google/gemini-3.7-flash|Gemini 3.7 Flash",
        "google/gemini-3.6-flash|Gemini 3.6 Flash",
        "google/gemini-3.5-flash|Gemini 3.5 Flash",
        "google/gemini-3.5-flash-lite|Gemini 3.5 Flash Lite",
        "google/gemini-3.1-flash-lite|Gemini 3.1 Flash Lite",
        "sakana/fugu-ultra|Fugu Ultra",
        "nvidia/nemotron-3-ultra-550b-a55b|Nemotron 3 Ultra",
        "thinkingmachines/inkling|Inkling",
        "thinkingmachines/inkling-small|Inkling Small",
        "stealth/glyph-cluster:free|Glyph Cluster",
        "poolside/laguna-s-2.1-free|Laguna S 2.1",
        "inclusionai/ling-3.0-flash-sante:free|Ling 3.0 Flash Sante",
        "inclusionai/ling-3.1-flash:free|Ling 3.1 Flash",
        "meta/muse-spark-1.1|Muse Spark 1.1",
        "meta/muse-spark-1.2|Muse Spark 1.2",
        "meta/muse-spark-1.2-contributor|Muse Spark 1.2 Contributor",
        "meta/muse-spark-1.3|Muse Spark 1.3",
        "meta/muse-spark-1.3-contributor|Muse Spark 1.3 Contributor",
        "xai/grok-4.5|Grok 4.5",
        "xai/grok-4.6|Grok 4.6",
        "xai/grok-4.7|Grok 4.7",
        "mistral/mistral-large-4|Mistral Large 4",
      ],
      keyStore: "lumina-api-key-commandcode",
      keyHint: "Studio 生成的 API Key",
      keyPattern: null,
    },
    factory: {
      id: "factory",
      label: "Factory（VPS 中转）",
      model: "deepseek-v4.1-flash",
      // 与 VPS 上 droid exec --help 的可用模型一致；relais 的 ALLOWED_MODELS 同步此列表
      models: [
        "auto|Auto Model（自动选模型）",
        "claude-fable-5.1|Claude Fable 5.1",
        "claude-fable-5|Claude Fable 5",
        "claude-opus-5-5|Claude Opus 5.5",
        "claude-opus-5|Claude Opus 5",
        "claude-opus-5-fast|Claude Opus 5 Fast",
        "claude-opus-4-8|Claude Opus 4.8",
        "claude-opus-4-8-fast|Claude Opus 4.8 Fast",
        "claude-opus-4-7|Claude Opus 4.7",
        "claude-opus-4-6|Claude Opus 4.6",
        "claude-opus-4-5-20251101|Claude Opus 4.5",
        "claude-sonnet-5|Claude Sonnet 5",
        "claude-sonnet-4-6|Claude Sonnet 4.6",
        "claude-sonnet-4-5-20250929|Claude Sonnet 4.5",
        "claude-haiku-4-5-20251001|Claude Haiku 4.5",
        "gpt-6-astra|GPT-6 Astra",
        "gpt-6-sol|GPT-6 Sol",
        "gpt-6-luna|GPT-6 Luna",
        "gpt-5.6-sol|GPT-5.6 Sol",
        "gpt-5.6-sol-fast|GPT-5.6 Sol Fast",
        "gpt-5.6-terra|GPT-5.6 Terra",
        "gpt-5.6-luna|GPT-5.6 Luna",
        "gpt-5.5|GPT-5.5",
        "gpt-5.5-fast|GPT-5.5 Fast",
        "gpt-5.5-pro|GPT-5.5 Pro",
        "gpt-5.4|GPT-5.4",
        "gpt-5.4-fast|GPT-5.4 Fast",
        "gpt-5.4-mini|GPT-5.4 Mini",
        "gpt-5.4-mini-fast|GPT-5.4 Mini Fast",
        "gpt-5.3-codex|GPT-5.3-Codex",
        "gpt-5.3-codex-fast|GPT-5.3-Codex Fast",
        "gpt-5.2|GPT-5.2",
        "gemini-3.1-pro-preview|Gemini 3.1 Pro",
        "gemini-3.8-flash|Gemini 3.8 Flash",
        "gemini-3.7-flash|Gemini 3.7 Flash",
        "gemini-3.6-flash|Gemini 3.6 Flash",
        "gemini-3.5-flash|Gemini 3.5 Flash",
        "gemini-3-flash-preview|Gemini 3 Flash",
        "inkling|Inkling",
        "mistral-medium-3.5|Mistral Medium 3.5",
        "glm-5.3-flash|GLM-5.3-Flash",
        "glm-5.3|GLM-5.3",
        "glm-5.2|GLM-5.2",
        "kimi-k3|Kimi K3",
        "qwen3.8-max|Qwen3.8 Max",
        "nemotron-3-ultra|Nemotron 3 Ultra",
        "deepseek-v4.1-flash|DeepSeek V4.1 Flash",
        "grok-4.7|Grok 4.7",
        "grok-4.6|Grok 4.6",
        "grok-4.5|Grok 4.5",
      ],
      keyStore: "lumina-api-key-factory",
      keyHint: "中转口令",
      keyPattern: null,
      baseStore: "lumina-factory-base",
      // 中转要等 droid exec 整轮跑完才回包（服务端默认最多 90s），CapacitorHttp 又会缓冲整个响应，
      // 流式请求沿用 30s 连接超时会把正常的慢回复全部掐断。须小于 STREAM_IDLE_TIMEOUT_MS（120s）。
      requestTimeoutMs: 105_000,
    },
  };
  const DEFAULT_PROVIDER = "opencode";
  const PROVIDER_STORE = "lumina-api-provider";
  const MODEL_STORE_PREFIX = "lumina-api-model:";
  const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
  const MIN_KEY = 20;

  function currentProvider() {
    let id = null;
    try {
      id = localStorage.getItem(PROVIDER_STORE);
    } catch {
      /* ignore */
    }
    return AI_PROVIDERS[id] || AI_PROVIDERS[DEFAULT_PROVIDER];
  }
  function normalizeProviderBase(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (!/^https:\/\//i.test(raw)) return null;
    try {
      const url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        return null;
      }
      let pathname = url.pathname.replace(/\/+$/, "");
      if (!pathname.endsWith("/v1")) pathname += "/v1";
      return `${url.origin}${pathname || "/v1"}`;
    } catch {
      return null;
    }
  }
  function providerBase(provider) {
    if (!provider.baseStore) return provider.base;
    try {
      return normalizeProviderBase(localStorage.getItem(provider.baseStore)) || "";
    } catch {
      return "";
    }
  }
  const aiEndpoint = (provider = currentProvider(), base = providerBase(provider)) =>
    base ? `${base}/chat/completions` : "";

  /** 服务商的内置模型列表："id|label" → {id, label}；label 缺省用 id */
  function providerModels(provider) {
    return (provider.models || []).map((entry) => {
      const [id, ...rest] = String(entry).split("|");
      return { id: id.trim(), label: (rest.join("|").trim() || id.trim()) };
    });
  }

  /** 当前服务商的已选模型；没选过用默认 */
  function selectedModel(provider = currentProvider()) {
    try {
      const stored = localStorage.getItem(MODEL_STORE_PREFIX + provider.id);
      if (stored && MODEL_ID_RE.test(stored)) return stored;
    } catch {
      /* ignore */
    }
    return provider.model;
  }

  function setProviderModel(providerId, modelId) {
    const p = AI_PROVIDERS[providerId];
    if (!p) return { ok: false, error: "未知服务商：" + providerId };
    const m = String(modelId || "").trim();
    if (!MODEL_ID_RE.test(m)) return { ok: false, error: "模型 ID 不合法" };
    try {
      localStorage.setItem(MODEL_STORE_PREFIX + p.id, m);
    } catch {
      /* ignore */
    }
    if (selectedModel(p) !== m) {
      return { ok: false, error: "无法保存模型选择（存储不可用）" };
    }
    return { ok: true, model: m };
  }

  /** claude-* 在 Command Code 上必须走 Anthropic Messages 接口 */
  function apiStyle(provider, model) {
    return provider.anthropic && /^claude/i.test(String(model || ""))
      ? "anthropic"
      : "openai";
  }

  const aiModel = (provider = currentProvider()) => selectedModel(provider);

  const LIMITS = {
    maxActiveRequests: 8,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 120,
    maxRequestsPerDay: 2000,
    maxMessages: 48,
    perMessageChars: { system: 16000, assistant: 12000, user: 12000, tool: 8000 },
    totalChars: 160000,
    maxTokens: { min: 64, max: 8192, default: 2048 },
    connectTimeoutMs: 30000,
    completeTimeoutMs: 120000,
    streamIdleTimeoutMs: 90000,
    maxSseLineChars: 1024 * 1024,
    maxStreamResponseChars: 256 * 1024,
    maxResponseContentChars: 96 * 1024,
    maxResponseReasoningChars: 128 * 1024,
    maxToolArgumentsChars: 32 * 1024,
    maxToolNameChars: 256,
    maxToolCallIdChars: 256,
    maxToolCallsPerResponse: 32,
    maxCompleteResponseChars: 256 * 1024,
    maxErrorResponseChars: 8 * 1024,
    apiKeyCacheMs: 60000,
  };

  const REQUEST_ID_RE = /^[A-Za-z0-9.:-]{1,128}$/;
  const ROLES = new Set(["system", "user", "assistant", "tool"]);
  const TOOL_CHOICES = new Set(["auto", "none", "required"]);
  /** 外层 pending 闲置超时：流读闲置上限 + 缓冲，避免与 consumeStream 的 90s 对不上 */
  const STREAM_IDLE_TIMEOUT_MS = LIMITS.streamIdleTimeoutMs + 30_000;
  const ABORT_FALLBACK_MS = 10_000;
  const MAX_PENDING_STREAMS = 16;

  function redactSecrets(text) {
    if (typeof text !== "string" || !text) return text;
    let out = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, (m) => m.slice(0, 6) + "***");
    // 无固定前缀的 key（如 Command Code）：按已知 key 原文脱敏
    const known = keyCache && keyCache.value;
    if (known && known.length >= 8) out = out.split(known).join(known.slice(0, 4) + "***");
    return out.replace(/(Bearer\s+)[^\s"']{8,}/gi, "$1***");
  }

  function normalizeRequestId(value) {
    const s = typeof value === "string" ? value.trim() : "";
    return REQUEST_ID_RE.test(s) ? s : null;
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  }

  function isAbortLike(err) {
    return err?.name === "AbortError" || err?.name === "TimeoutError";
  }

  /**
   * 把 fetch / 原生 HTTP 失败整理成可读信息（真机「Load failed」往往是 CSP/CORS/网络）。
   * @returns {{ code: string, message: string, status?: number }}
   */
  function classifyRequestError(err, { url, status, bodySnippet } = {}) {
    const name = err?.name || "";
    const raw = String(err?.message || err || "");
    const lower = raw.toLowerCase();
    const st = Number.isFinite(status) ? status : Number.isFinite(err?.status) ? err.status : null;

    if (isAbortLike(err) || name === "TimeoutError") {
      return {
        code: name === "TimeoutError" || /timeout/i.test(raw) ? "TIMEOUT" : "ABORTED",
        message: name === "TimeoutError" || /timeout/i.test(raw) ? "请求超时" : "已停止",
        status: st || undefined,
      };
    }
    if (err?.code === "NO_KEY") {
      return { code: "NO_KEY", message: raw };
    }
    if (st === 401 || st === 403) {
      return {
        code: "AUTH",
        message: `鉴权失败（HTTP ${st}）：API Key 无效或无权限。${bodySnippet ? " " + bodySnippet.slice(0, 120) : ""}`.trim(),
        status: st,
      };
    }
    if (st === 404) {
      return {
        code: "NOT_FOUND",
        message: `资源不存在（HTTP 404）：请检查模型名或接口路径。${bodySnippet ? " " + bodySnippet.slice(0, 120) : ""}`.trim(),
        status: 404,
      };
    }
    if (st === 429) {
      return {
        code: "RATE_LIMIT_REMOTE",
        message: `远程限流（HTTP 429）：请稍后再试。${bodySnippet ? " " + bodySnippet.slice(0, 120) : ""}`.trim(),
        status: 429,
      };
    }
    if (st != null && st >= 500) {
      return {
        code: "SERVER",
        message: `服务端错误（HTTP ${st}）。${bodySnippet ? " " + bodySnippet.slice(0, 120) : ""}`.trim(),
        status: st,
      };
    }
    if (st != null && st >= 400) {
      return {
        code: "HTTP_" + st,
        message: `API ${st}: ${(bodySnippet || raw).slice(0, 200)}`,
        status: st,
      };
    }
    // WebKit：CSP / CORS / 断网 均常表现为 TypeError: Load failed
    if (
      name === "TypeError" ||
      /load failed|failed to fetch|networkerror|network request failed|the internet connection appears to be offline/i.test(
        lower
      )
    ) {
      return {
        code: "NETWORK",
        message:
          "网络不可达或请求被拦截（CSP/CORS/离线）。若 Console 含 Content Security Policy 则为 CSP；含 CORS / Access-Control 则为跨域；否则检查网络与 CapacitorHttp。原文: " +
          raw.slice(0, 120),
      };
    }
    return {
      code: err?.code || "REQUEST_FAILED",
      message: redactSecrets(raw).slice(0, 400),
      status: st || undefined,
    };
  }

  function logRequestFailure(tag, err, meta = {}) {
    try {
      console.error("[luminaAI]", tag, {
        name: err?.name,
        message: err?.message,
        code: err?.code,
        status: err?.status ?? meta.status,
        url: meta.url || aiEndpoint(),
        stack: err?.stack,
        raw: err,
      });
    } catch {
      /* ignore */
    }
  }

  function getTools() {
    const pack = globalThis.LUMINA_AGENT_TOOLS;
    return (pack && pack.tools) || [];
  }

  /* ----------------------------- key store（Keychain / localStorage） ----------------------------- */
  let keyCache = { provider: null, value: null, at: 0 };
  function cacheFor(provider = currentProvider()) {
    return keyCache.provider === provider.id ? keyCache : null;
  }
  /** providerId 显式传入：异步读 key 期间用户可能已切换服务商，别把旧家的 key 记到新家名下 */
  function storeCache(key, providerId = currentProvider().id) {
    if (providerId !== currentProvider().id) return;
    keyCache = { provider: providerId, value: key, at: Date.now() };
  }
  let keyWarm = null;
  let keyWarmProvider = null;

  function secure() {
    return globalThis.LUMINA_SECURE_STORE || null;
  }
  function usesKeychain() {
    return secure()?.backend?.() === "keychain";
  }

  function parseApiKey(raw, provider = currentProvider()) {
    const line = String(raw || "").trim();
    if (!line) return null;
    const m = line.match(/^(?:api[_-]?key\s*[=:]\s*)?(\S+)$/i);
    const key = m ? m[1] : null;
    if (!key || key.length < MIN_KEY) return null;
    // ClickUp 个人 token 误贴到 AI 栏
    if (/^pk_/.test(key)) return null;
    if (provider.keyPattern && !provider.keyPattern.test(key)) return null;
    return key;
  }

  function loadKeyFromLocalStorage(provider = currentProvider()) {
    try {
      return parseApiKey(localStorage.getItem(provider.keyStore) || "", provider);
    } catch {
      return null;
    }
  }

  async function warmApiKey(provider = currentProvider()) {
    // 按服务商预热：切换后要给新服务商的 key 做一次 Keychain 迁移
    if (keyWarm && keyWarmProvider === provider.id) return keyWarm;
    const p = (async () => {
      const s = secure();
      if (s?.migrateKey) {
        const v = parseApiKey(await s.migrateKey(provider.keyStore), provider);
        storeCache(v, provider.id);
        return v;
      }
      const v = loadKeyFromLocalStorage(provider);
      storeCache(v, provider.id);
      return v;
    })();
    keyWarm = p;
    keyWarmProvider = provider.id;
    try {
      return await p;
    } catch (err) {
      // 失败后允许下次重试，避免永久卡在 rejected promise
      if (keyWarm === p) keyWarm = null;
      throw err;
    }
  }

  // 启动预热
  warmApiKey().catch(() => {});

  async function resolveApiKey({ refresh = false, provider = currentProvider() } = {}) {
    const now = Date.now();
    let c = cacheFor(provider);
    if (!refresh && c && now - c.at < LIMITS.apiKeyCacheMs) {
      return c.value;
    }
    await warmApiKey(provider);
    c = cacheFor(provider);
    if (!refresh && c && now - c.at < LIMITS.apiKeyCacheMs) {
      return c.value;
    }
    const s = secure();
    if (s?.get) {
      try {
        const v = parseApiKey(await s.get(provider.keyStore), provider);
        storeCache(v, provider.id);
        return v;
      } catch (err) {
        if (usesKeychain()) throw err;
      }
    }
    if (usesKeychain()) return null;
    const v = loadKeyFromLocalStorage(provider);
    storeCache(v, provider.id);
    return v;
  }

  async function setApiKey(raw) {
    const provider = currentProvider();
    const line = String(raw || "").trim();
    if (!line) {
      const s = secure();
      if (s?.remove) {
        try {
          const removed = await s.remove(provider.keyStore);
          if (!removed && usesKeychain()) return { ok: false, error: "Keychain 清除失败，请稍后重试" };
        } catch {
          if (usesKeychain()) return { ok: false, error: "Keychain 清除失败，请稍后重试" };
        }
      }
      if (usesKeychain()) {
        storeCache(null, provider.id);
        return { ok: true, backend: "keychain" };
      }
      try {
        localStorage.removeItem(provider.keyStore);
      } catch {
        /* ignore */
      }
      storeCache(null, provider.id);
      return { ok: true };
    }
    const key = parseApiKey(line, provider);
    if (!key) {
      return {
        ok: false,
        error: `API Key 格式无效：需要 ${provider.keyHint} 且至少 ${MIN_KEY} 字符`,
      };
    }
    const s = secure();
    let ok = false;
    if (s?.set) {
      try {
        ok = await s.set(provider.keyStore, key);
      } catch {
        ok = false;
      }
    }
    if (!ok && usesKeychain()) {
      return { ok: false, error: "Keychain 保存失败；为保护密钥，未写入本地存储" };
    }
    if (!ok) {
      try {
        localStorage.setItem(provider.keyStore, key);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) return { ok: false, error: "无法保存 Key（存储不可用）" };
    storeCache(key, provider.id);
    return { ok: true, backend: s?.backend?.() || "localStorage" };
  }

  function setProviderBase(id, value) {
    const provider = AI_PROVIDERS[id];
    if (!provider?.baseStore) {
      return { ok: false, error: "该服务商不支持中转地址" };
    }
    const raw = String(value ?? "").trim();
    const base = raw ? normalizeProviderBase(raw) : "";
    if (base === null) {
      return { ok: false, error: "中转地址必须是有效的 HTTPS 地址" };
    }
    try {
      localStorage.setItem(provider.baseStore, base);
      if (providerBase(provider) !== base) {
        return { ok: false, error: "无法保存中转地址（存储不可用）" };
      }
    } catch {
      return { ok: false, error: "无法保存中转地址（存储不可用）" };
    }
    return { ok: true, base };
  }

  async function hasApiKeyMasked() {
    const k = await resolveApiKey({ refresh: true });
    if (!k) return null;
    return k.slice(0, 6) + "…" + k.slice(-4);
  }

  /* ----------------------------- budget ----------------------------- */
  class RequestBudget {
    constructor() {
      this.windowMs = LIMITS.rateLimitWindowMs;
      this.maxPerWindow = LIMITS.rateLimitMax;
      this.maxPerDay = LIMITS.maxRequestsPerDay;
      this.dayKey = "";
      this.dayTotal = 0;
      this.hits = [];
    }
    dayKeyNow() {
      const d = new Date();
      return (
        d.getFullYear() +
        "-" +
        String(d.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getDate()).padStart(2, "0")
      );
    }
    tryConsume() {
      const now = Date.now();
      const dk = this.dayKeyNow();
      if (this.dayKey !== dk) {
        this.dayKey = dk;
        this.dayTotal = 0;
      }
      this.hits = this.hits.filter((t) => now - t < this.windowMs);
      if (this.hits.length >= this.maxPerWindow) {
        return {
          ok: false,
          code: "RATE_LIMIT",
          message: `请求过快（${this.maxPerWindow}/分钟），请稍后再试`,
        };
      }
      if (this.dayTotal >= this.maxPerDay) {
        return {
          ok: false,
          code: "DAY_LIMIT",
          message: `今日请求已达上限（${this.maxPerDay}），明天再试`,
        };
      }
      this.hits.push(now);
      this.dayTotal += 1;
      return { ok: true };
    }
    snapshot() {
      const now = Date.now();
      this.hits = this.hits.filter((t) => now - t < this.windowMs);
      return {
        windowCount: this.hits.length,
        dayTotal: this.dayTotal,
        dayKey: this.dayKey || this.dayKeyNow(),
      };
    }
  }
  const requestBudget = new RequestBudget();

  /* ----------------------------- messages ----------------------------- */
  function clipMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const first = messages[0];
    const hasSystem = first && typeof first === "object" && first.role === "system";
    const systemMsg = hasSystem
      ? {
          role: "system",
          content: String(first.content ?? "").slice(0, LIMITS.perMessageChars.system),
        }
      : null;
    const rest = hasSystem ? messages.slice(1) : messages;
    const list = rest.slice(-(LIMITS.maxMessages - (systemMsg ? 1 : 0)));
    let total = systemMsg ? systemMsg.content.length : 0;
    const out = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m || typeof m !== "object") continue;
      const role = ROLES.has(m.role) ? m.role : "user";
      const cap = LIMITS.perMessageChars[role] || 8000;
      let content = m.content == null ? "" : String(m.content);
      if (content.length > cap) content = content.slice(0, cap) + "…";
      const item = { role, content };
      if (role === "tool") item.tool_call_id = String(m.tool_call_id || "");
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        item.tool_calls = m.tool_calls.map((tc) => ({
          id: String(tc?.id || ""),
          type: String(tc?.type || "function"),
          function: {
            name: String(tc?.function?.name || tc?.name || ""),
            arguments:
              typeof tc?.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc?.function?.arguments || tc?.arguments || {}),
          },
        }));
      }
      total += content.length;
      if (total > LIMITS.totalChars && out.length) break;
      out.unshift(item);
    }
    // drop orphan tools at head
    while (out.length && out[0].role === "tool") out.shift();
    if (systemMsg) out.unshift(systemMsg);
    return out;
  }

  function normalizePayload(payload) {
    const src = payload && typeof payload === "object" ? payload : {};
    if (!Array.isArray(src.messages) || !src.messages.length) {
      throw new TypeError("messages 不能为空");
    }
    const messages = src.messages.map((m, i) => {
      if (!m || typeof m !== "object") throw new TypeError(`messages[${i}] 不是对象`);
      const role = ROLES.has(m.role) ? m.role : "user";
      const out = { role, content: m.content == null ? "" : String(m.content) };
      if (role === "tool") out.tool_call_id = String(m.tool_call_id || "");
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: String(tc?.id || ""),
          type: String(tc?.type || "function"),
          function: {
            name: String(tc?.function?.name || tc?.name || ""),
            arguments:
              typeof tc?.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc?.function?.arguments || tc?.arguments || {}),
          },
        }));
      }
      return out;
    });
    const out = { messages };
    if (typeof src.tools === "boolean") out.tools = src.tools;
    if (typeof src.tool_choice === "string" && TOOL_CHOICES.has(src.tool_choice)) {
      out.tool_choice = src.tool_choice;
    }
    if (Number.isFinite(src.temperature)) {
      out.temperature = Math.min(Math.max(Number(src.temperature), 0), 2);
    }
    if (Number.isFinite(src.max_tokens)) out.max_tokens = Math.trunc(Number(src.max_tokens));
    return out;
  }

  /* ----------------------------- SSE ----------------------------- */
  class SseLineBuffer {
    constructor() {
      this.buf = "";
    }
    push(chunk) {
      this.buf += chunk;
      if (this.buf.length > LIMITS.maxSseLineChars) {
        const err = new Error("SSE 行过长");
        err.code = "RESPONSE_TOO_LARGE";
        throw err;
      }
      const out = [];
      while (true) {
        const idx = this.buf.indexOf("\n");
        if (idx < 0) break;
        let line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") out.push(payload);
        }
      }
      return out;
    }
    flush() {
      if (!this.buf) return [];
      const line = this.buf;
      this.buf = "";
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") return [payload];
      }
      return [];
    }
  }

  function finalizeToolCalls(toolMap) {
    return Object.keys(toolMap)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => {
        const tc = toolMap[i];
        return {
          id: tc.id || "",
          type: tc.type || "function",
          function: {
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "",
          },
        };
      })
      .filter((tc) => tc.function.name);
  }

  /* ---------------------- Anthropic Messages 适配（claude-*） ---------------------- */

  /** OpenAI messages → Anthropic {system, messages}；tool 结果并入相邻 user 消息 */
  function toAnthropicMessages(messages) {
    const system = [];
    const out = [];
    const textBlocks = (content) => [{ type: "text", text: String(content ?? "") }];
    for (const m of messages) {
      if (m.role === "system") {
        system.push(String(m.content || ""));
        continue;
      }
      if (m.role === "tool") {
        const block = {
          type: "tool_result",
          tool_use_id: String(m.tool_call_id || ""),
          content: String(m.content ?? ""),
        };
        const last = out[out.length - 1];
        if (last?.role === "user" && last.__toolResults) {
          last.content.push(block);
        } else {
          out.push({ role: "user", content: [block], __toolResults: true });
        }
        continue;
      }
      if (m.role === "assistant") {
        const blocks = [];
        if (m.content) blocks.push({ type: "text", text: String(m.content) });
        for (const tc of m.tool_calls || []) {
          let input = {};
          try {
            input = JSON.parse(tc.function?.arguments || "{}");
          } catch {
            /* 保持空对象 */
          }
          blocks.push({
            type: "tool_use",
            id: String(tc.id || ""),
            name: String(tc.function?.name || ""),
            input,
          });
        }
        out.push({ role: "assistant", content: blocks.length ? blocks : textBlocks("") });
        continue;
      }
      out.push({ role: "user", content: textBlocks(m.content) });
    }
    for (const m of out) delete m.__toolResults;
    return { system: system.join("\n\n"), messages: out };
  }

  function toAnthropicTools(tools) {
    return tools.map((t) => ({
      name: String(t.function?.name || ""),
      description: String(t.function?.description || ""),
      input_schema: t.function?.parameters || { type: "object", properties: {} },
    }));
  }

  function toAnthropicToolChoice(choice) {
    if (choice === "required") return { type: "any" };
    if (choice === "none") return { type: "none" };
    return { type: "auto" };
  }

  const ANTHROPIC_STOP = {
    end_turn: "stop",
    stop_sequence: "stop",
    pause_turn: "stop",
    tool_use: "tool_calls",
    max_tokens: "length",
    refusal: "content_filter",
  };

  /** Anthropic 非流式 JSON → OpenAI choices 形状，让现有解析路径复用 */
  function anthropicToOpenAI(data) {
    const texts = [];
    let reasoning = "";
    const calls = [];
    for (const b of data?.content || []) {
      if (b.type === "text" && b.text) texts.push(b.text);
      else if (b.type === "thinking" && b.thinking) reasoning += b.thinking;
      else if (b.type === "tool_use") {
        calls.push({
          id: String(b.id || ""),
          type: "function",
          function: {
            name: String(b.name || ""),
            arguments: JSON.stringify(b.input || {}),
          },
        });
      }
    }
    const msg = { role: "assistant", content: texts.join(""), tool_calls: calls };
    if (reasoning) msg.reasoning_content = reasoning;
    return {
      model: data?.model,
      choices: [{
        message: msg,
        finish_reason: ANTHROPIC_STOP[data?.stop_reason] || data?.stop_reason || null,
      }],
    };
  }

  /** Anthropic SSE 事件 → OpenAI delta 形状，喂给 applyDelta */
  function anthropicEventDelta(evt) {
    if (evt?.type === "content_block_start" && evt.content_block?.type === "tool_use") {
      return {
        delta: {
          tool_calls: [{
            index: evt.index || 0,
            id: evt.content_block.id,
            type: "function",
            function: { name: evt.content_block.name || "" },
          }],
        },
      };
    }
    if (evt?.type === "content_block_delta") {
      const d = evt.delta || {};
      if (d.type === "text_delta" && d.text) return { delta: { content: d.text } };
      if (d.type === "thinking_delta" && d.thinking) {
        return { delta: { reasoning_content: d.thinking } };
      }
      if (d.type === "input_json_delta" && d.partial_json) {
        return {
          delta: {
            tool_calls: [{
              index: evt.index || 0,
              function: { arguments: d.partial_json },
            }],
          },
        };
      }
    }
    if (evt?.type === "message_delta") {
      const stop = evt.delta?.stop_reason;
      return { delta: {}, finish: ANTHROPIC_STOP[stop] || stop || "stop" };
    }
    return null;
  }

  /* ----------------------------- active requests ----------------------------- */
  const active = new Map();
  let seq = 0;
  function newRequestId() {
    seq += 1;
    return `req-${Date.now().toString(36)}-${seq.toString(36)}`;
  }

  function beginRequest(requestId, kind) {
    if (active.has(requestId)) {
      const err = new Error("requestId 正在使用中");
      err.code = "DUPLICATE_REQUEST";
      throw err;
    }
    if (active.size >= LIMITS.maxActiveRequests) {
      const err = new Error(`并发请求过多（上限 ${LIMITS.maxActiveRequests}）`);
      err.code = "TOO_MANY_REQUESTS";
      throw err;
    }
    const budget = requestBudget.tryConsume();
    if (!budget.ok) {
      const err = new Error(budget.message);
      err.code = budget.code;
      throw err;
    }
    const entry = { ac: new AbortController(), kind, startedAt: Date.now() };
    active.set(requestId, entry);
    return entry;
  }
  function endRequest(requestId, entry) {
    if (active.get(requestId) === entry) active.delete(requestId);
  }

  async function awaitRequest(entry, timeoutMs, run) {
    const signal = entry.ac.signal;
    const abortReason = () => signal.reason || new DOMException("已停止", "AbortError");
    if (signal.aborted) throw abortReason();
    let timer;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(abortReason());
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => entry.ac.abort(new DOMException("请求超时", "TimeoutError")),
        timeoutMs
      );
    });
    try {
      // CapacitorHttp 可能忽略 signal；本地等待必须独立收尾，包括正文读取。
      return await Promise.race([
        Promise.resolve().then(() => {
          if (signal.aborted) throw abortReason();
          return run();
        }),
        interrupted,
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function callChatApi({
    messages,
    tools,
    tool_choice,
    stream,
    temperature,
    max_tokens,
    signal,
    timeoutMs,
    provider = currentProvider(),
    base = providerBase(provider),
  }) {
    const model = selectedModel(provider);
    const style = apiStyle(provider, model);
    const endpoint =
      style === "anthropic" && base ? `${base}/messages` : aiEndpoint(provider, base);
    if (!base) {
      const err = new Error("未设置 Factory 中转地址，请在设置里填写 https:// 开头的地址。");
      err.code = "NO_BASE";
      throw err;
    }
    const key = await resolveApiKey({ provider });
    if (!key) {
      const err = new Error(
        `未找到 API Key。请在设置中为 ${provider.label} 粘贴 ${provider.keyHint} 密钥。`
      );
      err.code = "NO_KEY";
      throw err;
    }
    const clipped = clipMessages(messages);
    if (!clipped.length) {
      const err = new Error("消息为空");
      err.code = "EMPTY_MESSAGES";
      throw err;
    }
    const maxTokens = clampNumber(
      max_tokens,
      LIMITS.maxTokens.min,
      LIMITS.maxTokens.max,
      LIMITS.maxTokens.default
    );
    let body;
    if (style === "anthropic") {
      const { system, messages: converted } = toAnthropicMessages(clipped);
      body = {
        model,
        messages: converted,
        stream: Boolean(stream),
        temperature: clampNumber(temperature, 0, 2, 0.4),
        max_tokens: maxTokens,
      };
      if (system) body.system = system;
      if (tools?.length) {
        body.tools = toAnthropicTools(tools);
        body.tool_choice = toAnthropicToolChoice(tool_choice);
      }
    } else {
      body = {
        model,
        messages: clipped,
        stream: Boolean(stream),
        temperature: clampNumber(temperature, 0, 2, 0.4),
        max_tokens: maxTokens,
      };
      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = tool_choice || "auto";
      }
    }

    const linkAc = new AbortController();
    const onParent = () => linkAc.abort(signal.reason);
    if (signal) {
      if (signal.aborted) linkAc.abort(signal.reason);
      else signal.addEventListener("abort", onParent, { once: true });
    }
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => linkAc.abort(new DOMException("请求超时", "TimeoutError")),
        timeoutMs
      );
    }

    // 预检触发头：Authorization + application/json 足以触发 CORS preflight。
    // 真机 origin=capacitor://localhost 时，OpenCode 对 /chat/completions 的 OPTIONS
    // 曾返回 404 且无 ACAO → TypeError: Load failed。
    // 修复：capacitor.config 启用 CapacitorHttp（原生层发请求，绕开 CORS）。
    // 注意：原生 HTTP 会缓冲完整响应；SSE 仍可按全文解析，但不会边下边显。
    // 仅保留必要头，不附加 x-* 自定义头。
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
    // Anthropic 网关要求 x-api-key + anthropic-version；Bearer 一并带上兼容代理
    if (style === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    }
    // Accept 为 CORS 安全列表头，不单独触发 preflight；流式时声明 SSE 偏好
    if (stream) headers.Accept = "text/event-stream";

    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linkAc.signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onParent);
      const classified = classifyRequestError(err, { url: endpoint });
      logRequestFailure("fetch failed", err, { url: endpoint });
      const e = new Error(classified.message);
      e.code = classified.code;
      e.cause = err;
      throw e;
    }
    if (stream && timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, LIMITS.maxErrorResponseChars);
      } catch {
        /* ignore */
      }
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onParent);
      if (res.status === 401 || res.status === 403) {
        storeCache(null, provider.id);
      }
      const classified = classifyRequestError(null, {
        url: endpoint,
        status: res.status,
        bodySnippet: redactSecrets(detail),
      });
      logRequestFailure("HTTP error", { name: "HttpError", message: classified.message, status: res.status }, {
        url: endpoint,
        status: res.status,
      });
      const err = new Error(classified.message);
      err.status = res.status;
      err.code = classified.code;
      throw err;
    }

    return {
      res,
      style,
      dispose() {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onParent);
      },
      signal: linkAc.signal,
    };
  }

  async function consumeStream(res, onDelta, ctx = {}) {
    const { signal, onStall, style } = ctx;
    const reader = res.body?.getReader?.();
    let content = "";
    let reasoning = "";
    const toolMap = {};
    let finishReason = null;
    let aborted = false;
    let timedOut = false;
    let streamChars = 0;

    const consumeChars = (n) => {
      streamChars += n;
      if (streamChars > LIMITS.maxStreamResponseChars) {
        const err = new Error("流式响应超过安全上限");
        err.code = "RESPONSE_TOO_LARGE";
        throw err;
      }
    };

    const ensureAppendFits = (current, chunk, max, label) => {
      if (current.length + chunk.length > max) {
        const err = new Error(`${label}超过安全上限`);
        err.code = "RESPONSE_TOO_LARGE";
        throw err;
      }
    };

    const applyDelta = (delta, choiceFinish) => {
      if (choiceFinish) finishReason = choiceFinish;
      if (typeof delta.content === "string" && delta.content) {
        ensureAppendFits(content, delta.content, LIMITS.maxResponseContentChars, "回复正文");
        consumeChars(delta.content.length);
        content += delta.content;
        onDelta?.({ content: delta.content });
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        ensureAppendFits(
          reasoning,
          delta.reasoning_content,
          LIMITS.maxResponseReasoningChars,
          "推理内容"
        );
        consumeChars(delta.reasoning_content.length);
        reasoning += delta.reasoning_content;
        onDelta?.({ reasoning: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          if (!toolMap[idx]) {
            if (Object.keys(toolMap).length >= LIMITS.maxToolCallsPerResponse) {
              const err = new Error("工具调用数量超过上限");
              err.code = "RESPONSE_TOO_LARGE";
              throw err;
            }
            toolMap[idx] = { function: { name: "", arguments: "" } };
          }
          const slot = toolMap[idx];
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (typeof slot.id === "string" && slot.id.length > LIMITS.maxToolCallIdChars) {
            const err = new Error("工具调用 ID 过长");
            err.code = "RESPONSE_TOO_LARGE";
            throw err;
          }
          if (tc.function?.name) {
            ensureAppendFits(
              slot.function.name || "",
              tc.function.name,
              LIMITS.maxToolNameChars,
              "工具名"
            );
            consumeChars(tc.function.name.length);
            slot.function.name = (slot.function.name || "") + tc.function.name;
          }
          if (typeof tc.function?.arguments === "string") {
            ensureAppendFits(
              slot.function.arguments || "",
              tc.function.arguments,
              LIMITS.maxToolArgumentsChars,
              "工具参数"
            );
            consumeChars(tc.function.arguments.length);
            slot.function.arguments = (slot.function.arguments || "") + tc.function.arguments;
          }
        }
      }
    };

    if (!reader) {
      const text = await res.text();
      if (text.length > LIMITS.maxStreamResponseChars) {
        const err = new Error("流式响应超过安全上限");
        err.code = "RESPONSE_TOO_LARGE";
        throw err;
      }
      const parsed = JSON.parse(text);
      const data = style === "anthropic" ? anthropicToOpenAI(parsed) : parsed;
      const choice = data?.choices?.[0];
      const msg = choice?.message || {};
      finishReason = choice?.finish_reason || null;
      if (msg.content) {
        if (String(msg.content).length > LIMITS.maxResponseContentChars) {
          const err = new Error("回复正文超过安全上限");
          err.code = "RESPONSE_TOO_LARGE";
          throw err;
        }
        content = msg.content;
        onDelta?.({ content: msg.content });
      }
      if (msg.reasoning_content) {
        if (String(msg.reasoning_content).length > LIMITS.maxResponseReasoningChars) {
          const err = new Error("推理内容超过安全上限");
          err.code = "RESPONSE_TOO_LARGE";
          throw err;
        }
        reasoning = msg.reasoning_content;
        onDelta?.({ reasoning: msg.reasoning_content });
      }
      if (Array.isArray(msg.tool_calls)) {
        if (msg.tool_calls.length > LIMITS.maxToolCallsPerResponse) {
          const err = new Error("工具调用数量超过上限");
          err.code = "RESPONSE_TOO_LARGE";
          throw err;
        }
        for (let i = 0; i < msg.tool_calls.length; i++) {
          const tc = msg.tool_calls[i];
          const id = String(tc?.id || "");
          const name = String(tc?.function?.name || "");
          const args =
            typeof tc?.function?.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc?.function?.arguments || {});
          if (
            id.length > LIMITS.maxToolCallIdChars ||
            name.length > LIMITS.maxToolNameChars ||
            args.length > LIMITS.maxToolArgumentsChars
          ) {
            const err = new Error("工具调用字段超过安全上限");
            err.code = "RESPONSE_TOO_LARGE";
            throw err;
          }
          toolMap[i] = {
            id,
            type: tc.type || "function",
            function: {
              name,
              arguments: args,
            },
          };
        }
      }
    } else {
      const decoder = new TextDecoder();
      const lines = new SseLineBuffer();
      let idleTimer = null;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => onStall?.(), LIMITS.streamIdleTimeoutMs);
      };
      const applyPayload = (payload) => {
        try {
          const json = JSON.parse(payload);
          if (style === "anthropic") {
            const ev = anthropicEventDelta(json);
            if (ev) applyDelta(ev.delta || {}, ev.finish || null);
            return;
          }
          const choice = json?.choices?.[0];
          applyDelta(choice?.delta || {}, choice?.finish_reason || null);
        } catch (err) {
          if (err?.code === "RESPONSE_TOO_LARGE") throw err;
        }
      };
      try {
        armIdle();
        while (true) {
          if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          for (const payload of lines.push(decoder.decode(value, { stream: true }))) {
            applyPayload(payload);
          }
        }
        for (const payload of lines.push(decoder.decode())) applyPayload(payload);
        for (const payload of lines.flush()) applyPayload(payload);
      } catch (err) {
        if (!isAbortLike(err)) throw err;
        aborted = true;
        timedOut = err?.name === "TimeoutError";
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
      }
    }

    const tool_calls = finalizeToolCalls(toolMap);
    if (!finishReason && !aborted) {
      finishReason = tool_calls.length ? "tool_calls" : "stop";
    }
    return { content, reasoning, tool_calls, finish_reason: finishReason, aborted, timedOut };
  }

  /* ----------------------------- stream pending (preload 同形) ----------------------------- */
  /** @type {Map<string, any>} */
  const pending = new Map();

  function safeCall(fn, arg) {
    if (typeof fn !== "function") return;
    try {
      fn(arg);
    } catch (err) {
      console.error("[luminaAI] 回调抛出异常：", err);
    }
  }
  function clearTimer(entry) {
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
  function settle(requestId) {
    const entry = pending.get(requestId);
    if (!entry || entry.settled) return null;
    entry.settled = true;
    clearTimer(entry);
    pending.delete(requestId);
    return entry;
  }
  function armIdle(requestId) {
    const entry = pending.get(requestId);
    if (!entry || entry.settled || entry.aborting) return;
    clearTimer(entry);
    entry.timer = setTimeout(() => {
      const dead = settle(requestId);
      if (!dead) return;
      const act = active.get(requestId);
      if (act) act.ac.abort(new DOMException("响应超时", "TimeoutError"));
      safeCall(
        dead.handlers.onError,
        `响应超时（${STREAM_IDLE_TIMEOUT_MS / 1000}s 无数据）`
      );
    }, STREAM_IDLE_TIMEOUT_MS);
  }
  function armAbortFallback(requestId) {
    const entry = pending.get(requestId);
    if (!entry || entry.settled) return;
    clearTimer(entry);
    entry.timer = setTimeout(() => {
      const dead = settle(requestId);
      if (!dead) return;
      safeCall(dead.handlers.onDone, {
        requestId,
        content: dead.content || "",
        reasoning: dead.reasoning || "",
        tool_calls: [],
        aborted: true,
        reason: "user",
        fallback: true,
      });
    }, ABORT_FALLBACK_MS);
  }

  function emitDelta(requestId, data) {
    const entry = pending.get(requestId);
    if (!entry || entry.settled) return;
    if (typeof data.content === "string" && data.content) entry.content += data.content;
    if (typeof data.reasoning === "string" && data.reasoning) entry.reasoning += data.reasoning;
    if (!entry.aborting) armIdle(requestId);
    safeCall(entry.handlers.onDelta, { requestId, ...data });
  }
  function emitDone(requestId, data) {
    const entry = settle(requestId);
    if (!entry) return;
    safeCall(entry.handlers.onDone, {
      ...data,
      requestId,
      content: data.content != null && data.content !== "" ? data.content : entry.content,
      reasoning:
        data.reasoning != null && data.reasoning !== "" ? data.reasoning : entry.reasoning,
    });
  }
  function emitError(requestId, error) {
    const entry = settle(requestId);
    if (!entry) return;
    safeCall(entry.handlers.onError, error || "未知错误");
  }

  function noKeyError(provider = currentProvider()) {
    return {
      ok: false,
      error: `未找到 API Key。请在设置中为 ${provider.label} 粘贴 ${provider.keyHint} 密钥。`,
      code: "NO_KEY",
    };
  }

  function noBaseError() {
    return {
      ok: false,
      error: "未设置 Factory 中转地址，请在设置里填写 https:// 开头的地址。",
      code: "NO_BASE",
    };
  }

  async function aiStatus(opts) {
    const provider = currentProvider();
    const base = providerBase(provider);
    const tools = getTools().map((t) => t.function.name);
    if (!base) {
      return {
        ...noBaseError(),
        provider: provider.id,
        model: selectedModel(provider),
        base,
        agent: true,
        tools,
        source: null,
        budget: requestBudget.snapshot(),
        platform: "ios",
        secureBackend: secure()?.backend?.() || "localStorage",
      };
    }
    let key;
    let storageError = null;
    try {
      key = await resolveApiKey({ refresh: Boolean(opts && opts.refresh), provider });
    } catch (err) {
      storageError = err;
    }
    if (!key) {
      return {
        ok: false,
        provider: provider.id,
        model: selectedModel(provider),
        base,
        agent: true,
        tools,
        source: null,
        error: storageError?.message || noKeyError(provider).error,
        code: storageError?.code || "NO_KEY",
        budget: requestBudget.snapshot(),
        platform: "ios",
        secureBackend: secure()?.backend?.() || "localStorage",
      };
    }
    return {
      ok: true,
      provider: provider.id,
      model: selectedModel(provider),
      base,
      agent: true,
      tools,
      source: "settings",
      budget: requestBudget.snapshot(),
      platform: "ios",
      secureBackend: secure()?.backend?.() || "localStorage",
    };
  }

  /* ----------------------------- public API ----------------------------- */
  window.luminaAI = {
    isDesktop: true, // chat.js 用此判断「有原生桥」；iOS 同样提供完整桥
    isIOS: true,
    agent: true,

    status(opts) {
      return aiStatus(opts && typeof opts === "object" ? opts : {});
    },
    tools() {
      return Promise.resolve({ ok: true, tools: getTools() });
    },

    setApiKey(raw) {
      return setApiKey(raw);
    },
    async getApiKeyMask() {
      return { ok: true, mask: await hasApiKeyMasked() };
    },
    providers() {
      return {
        ok: true,
        current: currentProvider().id,
        list: Object.values(AI_PROVIDERS).map((p) => ({
          id: p.id,
          label: p.label,
          model: selectedModel(p),
          defaultModel: p.model,
          models: providerModels(p),
          keyHint: p.keyHint,
          baseStore: Boolean(p.baseStore),
          base: providerBase(p),
        })),
      };
    },
    setProviderBase(id, url) {
      return setProviderBase(id, url);
    },
    setProvider(id) {
      if (!AI_PROVIDERS[id]) {
        return { ok: false, error: "未知服务商：" + id };
      }
      try {
        localStorage.setItem(PROVIDER_STORE, id);
      } catch {
        /* ignore */
      }
      if (currentProvider().id !== id) {
        return { ok: false, error: "无法保存服务商选择（存储不可用）" };
      }
      const p = currentProvider();
      warmApiKey(p).catch(() => {});
      return { ok: true, provider: p.id, model: selectedModel(p) };
    },
    setModel(modelId) {
      const p = currentProvider();
      const r = setProviderModel(p.id, modelId);
      return r.ok ? { ok: true, provider: p.id, model: r.model } : r;
    },
    async listModels(providerId) {
      const p = AI_PROVIDERS[providerId];
      if (!p) return { ok: false, error: "未知服务商：" + providerId };
      const base = providerBase(p);
      if (!base) {
        return { ok: true, models: providerModels(p), source: "static" };
      }
      const headers = { "Content-Type": "application/json" };
      try {
        const key = await resolveApiKey({ provider: p });
        if (key) headers.Authorization = `Bearer ${key}`;
      } catch {
        /* 无 key 也能拿公开列表 */
      }
      try {
        const res = await fetch(`${base}/models`, { method: "GET", headers });
        if (!res.ok) {
          return { ok: true, models: providerModels(p), source: "static", status: res.status };
        }
        const data = await res.json();
        const arr = Array.isArray(data?.data) ? data.data : [];
        const remote = arr
          .map((m) => ({
            id: String(m?.id || ""),
            label: String(m?.name || m?.id || ""),
          }))
          .filter((m) => m.id && MODEL_ID_RE.test(m.id));
        if (!remote.length) {
          return { ok: true, models: providerModels(p), source: "static" };
        }
        // 用内置列表里的中文别名；列表里没有的远端模型用远端名字
        const known = new Map(providerModels(p).map((m) => [m.id, m.label]));
        const merged = remote.map((m) => ({ id: m.id, label: known.get(m.id) || m.label }));
        return { ok: true, models: merged, source: "remote" };
      } catch {
        return { ok: true, models: providerModels(p), source: "static" };
      }
    },

    async complete(payload) {
      let body;
      let requestId;
      try {
        body = normalizePayload(payload);
        requestId = normalizeRequestId(payload?.requestId) || newRequestId();
      } catch (err) {
        return { ok: false, error: err?.message || "参数不合法" };
      }
      const provider = currentProvider();
      const base = providerBase(provider);
      const endpoint = aiEndpoint(provider, base);
      if (!base) return { requestId, ...noBaseError() };
      if (!(await resolveApiKey({ provider }))) {
        return { requestId, ...noKeyError(provider) };
      }

      let entry;
      try {
        entry = beginRequest(requestId, "complete");
      } catch (err) {
        return { ok: false, requestId, error: err.message, code: err.code };
      }

      try {
        return await awaitRequest(entry, LIMITS.completeTimeoutMs, async () => {
          let link = null;
          try {
            const useTools = payload?.tools !== false;
            const call = await callChatApi({
              messages: body.messages,
              tools: useTools ? getTools() : undefined,
              tool_choice: body.tool_choice || (useTools ? "auto" : undefined),
              stream: false,
              temperature: body.temperature,
              max_tokens: body.max_tokens ?? LIMITS.maxTokens.default,
              signal: entry.ac.signal,
              timeoutMs: 0,
              provider,
              base,
            });
            link = call;
            if (entry.ac.signal.aborted) throw entry.ac.signal.reason;
            const text = await call.res.text();
            if (entry.ac.signal.aborted) throw entry.ac.signal.reason;
            if (text.length > LIMITS.maxCompleteResponseChars) {
              return { ok: false, requestId, error: "回复过大", code: "RESPONSE_TOO_LARGE" };
            }
            const parsed = JSON.parse(text);
            const data = call.style === "anthropic" ? anthropicToOpenAI(parsed) : parsed;
            const choice = data?.choices?.[0] || {};
            const msg = choice.message || {};
            return {
              ok: true,
              requestId,
              model: data.model || selectedModel(provider),
              message: {
                role: "assistant",
                content: msg.content || "",
                reasoning_content: msg.reasoning_content || "",
                tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
              },
              finish_reason: choice.finish_reason || null,
            };
          } finally {
            // 即使原生请求在停止后才返回，也必须清理它自己的监听器。
            link?.dispose?.();
          }
        });
      } catch (err) {
        if (isAbortLike(err)) {
          return {
            ok: false,
            aborted: true,
            timedOut: err?.name === "TimeoutError",
            requestId,
            error: err?.name === "TimeoutError" ? "请求超时" : "已停止",
            code: err?.name === "TimeoutError" ? "TIMEOUT" : "ABORTED",
          };
        }
        if (err?.code === "NO_KEY") return { requestId, ...noKeyError(provider) };
        if (err?.code === "NO_BASE") return { requestId, ...noBaseError() };
        const classified = classifyRequestError(err, {
          url: endpoint,
          status: err?.status,
        });
        logRequestFailure("complete", err, { url: endpoint, status: err?.status });
        return {
          ok: false,
          requestId,
          error: classified.message,
          code: classified.code || err?.code,
          status: classified.status || err?.status,
        };
      } finally {
        endRequest(requestId, entry);
      }
    },

    async chat(payload, handlers = {}) {
      let body;
      let requestId;
      try {
        body = normalizePayload(payload);
        requestId = normalizeRequestId(payload?.requestId) || newRequestId();
      } catch (err) {
        const message = err?.message || "参数不合法";
        safeCall(handlers?.onError, message);
        return { ok: false, requestId: null, error: message };
      }
      const provider = currentProvider();
      const base = providerBase(provider);
      const endpoint = aiEndpoint(provider, base);

      if (pending.has(requestId)) {
        const message = "requestId 正在使用中";
        safeCall(handlers?.onError, message);
        return { ok: false, requestId, error: message };
      }
      if (pending.size >= MAX_PENDING_STREAMS) {
        const message = `本地流式会话过多（软上限 ${MAX_PENDING_STREAMS}）`;
        safeCall(handlers?.onError, message);
        return { ok: false, requestId, error: message };
      }
      if (!base) {
        const fail = noBaseError();
        safeCall(handlers?.onError, fail.error);
        return { ok: false, requestId, error: fail.error, code: fail.code };
      }
      if (!(await resolveApiKey({ provider }))) {
        const fail = noKeyError(provider);
        safeCall(handlers?.onError, fail.error);
        return { ok: false, requestId, error: fail.error };
      }

      let entry;
      try {
        entry = beginRequest(requestId, "stream");
      } catch (err) {
        safeCall(handlers?.onError, err.message);
        return { ok: false, requestId, error: err.message, code: err.code };
      }

      pending.set(requestId, {
        handlers: handlers && typeof handlers === "object" ? handlers : {},
        timer: null,
        aborting: false,
        settled: false,
        content: "",
        reasoning: "",
      });
      armIdle(requestId);

      const useTools = payload?.tools === true;

      (async () => {
        let link = null;
        try {
          const call = await callChatApi({
            messages: body.messages,
            tools: useTools ? getTools() : undefined,
            tool_choice: useTools
              ? body.tool_choice || "auto"
              : undefined,
            stream: true,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            signal: entry.ac.signal,
            timeoutMs: provider.requestTimeoutMs || LIMITS.connectTimeoutMs,
            provider,
            base,
          });
          link = call;
          const result = await consumeStream(
            call.res,
            (piece) => emitDelta(requestId, piece),
            {
              signal: call.signal,
              style: call.style,
              onStall: () =>
                entry.ac.abort(new DOMException("流已停顿", "TimeoutError")),
            }
          );
          emitDone(requestId, {
            content: result.content,
            reasoning: result.reasoning,
            tool_calls: result.tool_calls,
            finish_reason: result.finish_reason,
            ...(result.aborted
              ? { aborted: true, reason: result.timedOut ? "timeout" : "user" }
              : {}),
          });
        } catch (err) {
          if (isAbortLike(err)) {
            emitDone(requestId, {
              content: "",
              reasoning: "",
              tool_calls: [],
              finish_reason: null,
              aborted: true,
              reason: err?.name === "TimeoutError" ? "timeout" : "user",
            });
            return;
          }
          const classified = classifyRequestError(err, {
            url: endpoint,
            status: err?.status,
          });
          logRequestFailure("chat stream", err, { url: endpoint, status: err?.status });
          emitError(requestId, classified.message);
        } finally {
          link?.dispose?.();
          endRequest(requestId, entry);
        }
      })();

      return { ok: true, requestId, model: selectedModel(provider) };
    },

    async abort(requestId) {
      const id = normalizeRequestId(requestId);
      if (!id) return { ok: false, error: "requestId 不合法" };
      const entry = pending.get(id);
      if (entry && !entry.settled) entry.aborting = true;
      const act = active.get(id);
      if (!act) return { ok: false, error: "请求不存在或已结束" };
      act.ac.abort(new DOMException("已停止", "AbortError"));
      if (pending.get(id) && !pending.get(id).settled) armAbortFallback(id);
      return { ok: true };
    },
  };

  /* ClickUp */
  let pomoToastTimer = null;
  function notifyPomoResult(result) {
    const message =
      result?.code === "INDETERMINATE"
        ? "番茄已记录，但 ClickUp 上传结果未确认；稍后会自动核对，确认没写入会补发"
        : result?.ok === false && result?.queued === true
          ? "ClickUp 暂时连不上，番茄已加入待同步，联网后自动补传"
          : "";
    if (!message) return;
    if (typeof globalThis.toast === "function") {
      globalThis.toast(message);
      return;
    }
    if (typeof document !== "undefined") {
      const toastEl = document.getElementById("toast");
      const toastMsg = document.getElementById("toastMsg");
      if (toastEl && toastMsg) {
        const toastAction = document.getElementById("toastAction");
        if (toastAction) {
          toastAction.hidden = true;
          toastAction.onclick = null;
        }
        toastMsg.textContent = message;
        toastEl.classList.add("show");
        clearTimeout(pomoToastTimer);
        pomoToastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
        return;
      }
    }
    console.warn("[ClickUp]", message);
  }
  window.luminaClickUp = {
    logPomo(payload) {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu) return Promise.resolve({ ok: false, error: "ClickUp 模块未加载", retryable: false });
      const src = payload && typeof payload === "object" ? payload : {};
      let endedAt = Number(src.endedAt);
      if (!Number.isFinite(endedAt) || endedAt <= 0) endedAt = Date.now();
      return cu.logPomodoro({
        title: typeof src.title === "string" ? src.title : "",
        minutes: Number(src.minutes) || 0,
        endedAt,
        operationId: typeof src.operationId === "string" ? src.operationId : undefined,
      }).then((r) => {
        try {
          notifyPomoResult(r);
        } catch {
          /* A notification must not affect the upload result. */
        }
        return r;
      });
    },
    pushTodo(payload) {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu) return Promise.resolve({ ok: false, error: "ClickUp 模块未加载", retryable: false });
      const src = payload && typeof payload === "object" ? payload : {};
      return cu.pushTodo({
        title: typeof src.title === "string" ? src.title : "",
        priority: typeof src.priority === "string" ? src.priority : "",
        dueDate: typeof src.dueDate === "string" ? src.dueDate : null,
        todoId: typeof src.todoId === "string" ? src.todoId : undefined,
        operationId: typeof src.operationId === "string" ? src.operationId : undefined,
      });
    },
    setToken(token) {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu) return Promise.resolve({ ok: false, error: "ClickUp 模块未加载" });
      return Promise.resolve(cu.setStoredToken(token));
    },
    clearFailed() {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu?.clearFailedQueue) return Promise.resolve({ ok: false, error: "ClickUp 模块未加载" });
      return Promise.resolve({ ok: cu.clearFailedQueue() });
    },
    status() {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu) return Promise.resolve({ ok: false });
      return Promise.resolve(cu.status());
    },
  };

  // 冷启动冲队列
  setTimeout(() => {
    try {
      globalThis.LUMINA_MOBILE_CLICKUP?.flushQueue?.().catch(() => {});
    } catch {
      /* ignore */
    }
  }, 4000);
})();
