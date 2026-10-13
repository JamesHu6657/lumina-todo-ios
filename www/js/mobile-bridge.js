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
      // 离线兜底列表（取自 droid exec --help）；中转只接受其 ALLOWED_MODELS，其余模型返回 400，
      // 能连上中转时以 /models 返回的列表为准
      models: [
        "auto|Auto Model（自动选模型）",
        "claude-fable-5-1|Claude Fable 5.1",
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
      // droid exec 没有采样参数：中转会忽略 temperature / max_tokens（并在 X-Relay-Ignored-Params 声明）。
      // 不再发送，避免「设置了却静默不生效」。
      samplingParams: false,
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

  function chatEndpoint(provider, base, model = selectedModel(provider)) {
    if (!base) return "";
    return apiStyle(provider, model) === "anthropic" ? `${base}/messages` : aiEndpoint(provider, base);
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
    // 低于非流式请求的长输出阈值（约 21K），兼顾思考与正文
    anthropicThinkingMaxTokens: 16000,
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
    maxListedModels: 500,
    maxModelsResponseChars: 256 * 1024,
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
  // 每个服务商的 key 代际：保存/清除时递增，迁移等迟到的读取不得覆盖用户的新操作
  const keyGenerations = new Map();
  function keyGeneration(providerId) {
    return keyGenerations.get(providerId) || 0;
  }
  function bumpKeyGeneration(providerId) {
    keyGenerations.set(providerId, keyGeneration(providerId) + 1);
  }

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
    const gen = keyGeneration(provider.id);
    const adopt = (v) => {
      if (gen !== keyGeneration(provider.id)) return cacheFor(provider)?.value ?? null;
      storeCache(v, provider.id);
      return v;
    };
    const p = (async () => {
      const s = secure();
      if (s?.migrateKey) {
        return adopt(parseApiKey(await s.migrateKey(provider.keyStore), provider));
      }
      return adopt(loadKeyFromLocalStorage(provider));
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
      const gen = keyGeneration(provider.id);
      try {
        const v = parseApiKey(await s.get(provider.keyStore), provider);
        if (gen !== keyGeneration(provider.id)) return cacheFor(provider)?.value ?? null;
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
    bumpKeyGeneration(provider.id);
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
  /**
   * 按 SSE 规范组装完整事件（WHATWG EventSource 解析规则）：
   *   - 行结束符可为 \n / \r\n / \r；
   *   - 空行才派发一个事件；同一事件内所有 `data:` 行以 "\n" 拼接后再交给上层解析；
   *   - `:` 开头为注释（保活）；`event:` 记录事件类型（如 `event: error`）。
   * 逐行 JSON.parse 会把多行 data（例如多行 error 对象）当作“非 JSON 保活”丢掉，
   * 进而把带错误的流当成功收尾并执行已累计的工具调用——这里统一按事件处理。
   */
  class SseEventParser {
    constructor() {
      this.buf = "";
      this.dataLines = [];
      this.dataChars = 0;
      this.eventType = "";
      this.sawCR = false;
      this.started = false;
      // 收到 [DONE] 才算服务端正常收尾；没有它的 EOF 是断流，不能当成功
      this.done = false;
    }
    _tooLarge() {
      const err = new Error("SSE 事件过长");
      err.code = "RESPONSE_TOO_LARGE";
      return err;
    }
    _line(line, out) {
      if (line === "") {
        this._dispatch(out);
        return;
      }
      if (line.charCodeAt(0) === 58 /* ":" */) return; // 注释 / 保活
      const colon = line.indexOf(":");
      let field;
      let value;
      if (colon < 0) {
        field = line;
        value = "";
      } else {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value.charCodeAt(0) === 32) value = value.slice(1);
      }
      if (field === "data") {
        this.dataChars += value.length + 1;
        if (this.dataChars > LIMITS.maxSseLineChars) throw this._tooLarge();
        this.dataLines.push(value);
      } else if (field === "event") {
        this.eventType = value;
      }
      // id / retry / 未知字段：与本客户端无关，按规范忽略
    }
    _dispatch(out) {
      const type = this.eventType;
      const hasData = this.dataLines.length > 0;
      const data = this.dataLines.join("\n");
      this.dataLines = [];
      this.dataChars = 0;
      this.eventType = "";
      // 规范：无 data 的事件不派发；但 `event: error` 即使没有 data 也必须让本轮失败
      if (!hasData && type !== "error") return;
      out.push({ type: type || "message", data });
    }
    push(chunk) {
      const out = [];
      let text = String(chunk || "");
      if (!this.started && text) {
        this.started = true;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (this.sawCR && text.charCodeAt(0) === 10) text = text.slice(1); // 跨块的 \r\n
      this.sawCR = false;
      this.buf += text;
      while (true) {
        const m = /\r\n|\r|\n/.exec(this.buf);
        if (!m) break;
        // 块尾的孤立 \r 可能是 \r\n 的前半，留待下一块确认
        if (m[0] === "\r" && m.index === this.buf.length - 1) {
          const line = this.buf.slice(0, m.index);
          this.buf = "";
          this.sawCR = true;
          this._line(line, out);
          break;
        }
        const line = this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this._line(line, out);
      }
      if (this.buf.length + this.dataChars > LIMITS.maxSseLineChars) throw this._tooLarge();
      return out;
    }
    /** EOF：残留的未完结行 / 事件也要交给上层（错误必须被看见；[DONE] 末尾可能缺空行） */
    flush() {
      const out = [];
      if (this.buf) {
        const line = this.buf;
        this.buf = "";
        this._line(line, out);
      }
      this._dispatch(out);
      return out;
    }
  }

  /**
   * 从一个完整 SSE 事件里识别“本轮失败”。任何错误形态都返回 Error：
   *   - `event: error`（无论 data 是否 JSON）；
   *   - JSON 顶层 `error` 字段（OpenAI 兼容）或 `type: "error"`（Anthropic 风格）；
   *   - 任一 choice 的 finish_reason 为 "error"。
   */
  function sseEventError(evt, json) {
    if (evt && evt.type === "error") {
      const fromJson = json && typeof json === "object" ? streamPayloadError(json) : null;
      if (fromJson) return fromJson;
      let detail = "";
      if (json && typeof json === "object" && typeof json.message === "string") detail = json.message;
      else if (json == null && evt.data) detail = String(evt.data);
      const err = new Error(
        "AI 服务在回复中途报错" + (detail ? "：" + redactSecrets(detail).slice(0, 200) : "")
      );
      err.code = "STREAM_ERROR";
      return err;
    }
    if (!json || typeof json !== "object") return null;
    const direct = streamPayloadError(json);
    if (direct) return direct;
    if (json.type === "error") {
      const inner = json.error && typeof json.error === "object" ? json.error : json;
      return streamPayloadError({ error: inner }) || streamPayloadError({ error: "error" });
    }
    if (Array.isArray(json.choices)) {
      for (const c of json.choices) {
        if (c && c.finish_reason === "error") {
          return streamPayloadError({ error: c.error || "finish_reason=error" });
        }
      }
    }
    return null;
  }

  function streamProtocolError(message) {
    const err = new Error("AI 回复格式异常（" + message + "），本轮结果已丢弃");
    err.code = "STREAM_ERROR";
    return err;
  }

  /** 响应体看起来是 SSE 文本（原生 HTTP 缓冲全文 / 服务端无视 stream:false 时） */
  function looksLikeSse(text, res) {
    let ct = "";
    try {
      ct = String(res?.headers?.get?.("content-type") || "");
    } catch {
      /* ignore */
    }
    if (/text\/event-stream/i.test(ct)) return true;
    return /^\uFEFF?\s*(data|event|id|retry)\s*:|^\uFEFF?\s*:/.test(String(text || "").slice(0, 64));
  }

  function finalizeToolCalls(toolMap) {
    return Object.keys(toolMap)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => {
        const tc = toolMap[i];
        // 审查四③：有 id/参数却没有工具名的槽位不是“可忽略的空槽”，而是残缺调用——整轮失败
        if (!tc.function?.name) throw streamProtocolError("工具调用缺少名称");
        return {
          id: tc.id || "",
          type: tc.type || "function",
          function: {
            name: tc.function.name,
            arguments: tc.function?.arguments || "",
          },
        };
      });
  }

  /**
   * 审查四②：finish_reason 统一校验。
   *   - null/undefined/"" → 尚未结束（返回 null）；
   *   - 非字符串（对象、数字…）→ 协议异常，整轮失败；
   *   - 字符串原样返回，由 assertFinishAllowsTools 判断能否执行工具。
   */
  function normalizeFinishReason(raw) {
    if (raw == null || raw === "") return null;
    if (typeof raw !== "string") throw streamProtocolError("finish_reason 结构异常");
    if (raw.length > 64) throw streamProtocolError("finish_reason 结构异常");
    return raw;
  }

  /** 只有正常结束（tool_calls / function_call / stop）的回复里的工具调用才可执行 */
  const TOOL_SAFE_FINISH = new Set(["tool_calls", "function_call", "stop"]);

  /**
   * 回复被截断（length / max_tokens）、被过滤（content_filter）或给了未知结束原因时，
   * 累计的工具调用可能残缺或被篡改：失败关闭，一条都不交给 agent-loop。
   * 纯文本回复不受影响（截断的文本没有副作用，照常返回并带上 finish_reason）。
   */
  function assertFinishAllowsTools(finishReason, toolCalls) {
    if (!toolCalls || !toolCalls.length) return;
    if (finishReason == null || TOOL_SAFE_FINISH.has(finishReason)) return;
    const why =
      finishReason === "length" || finishReason === "max_tokens"
        ? "回复被截断"
        : finishReason === "content_filter"
          ? "回复被内容过滤"
          : "回复结束状态异常";
    const err = new Error(
      `AI ${why}（finish_reason=${String(finishReason).slice(0, 32)}），工具调用未执行，本轮结果已丢弃`
    );
    err.code = "STREAM_TRUNCATED";
    throw err;
  }

  /**
   * 非流式整条 tool_call 校验：id/name/type 类型必须正确。arguments 允许字符串或对象
   * （部分兼容服务在非流式响应里直接给对象，这是整条而非分片，不存在“旧参数被沿用”的问题）。
   */
  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function validateBufferedToolCall(tc) {
    if (!tc || typeof tc !== "object" || Array.isArray(tc)) throw streamProtocolError("tool_call 结构异常");
    // 审查五 B：键存在就必须类型正确——显式 null 不等于缺省
    if (hasOwn(tc, "id") && typeof tc.id !== "string") throw streamProtocolError("tool_call id 异常");
    if (hasOwn(tc, "type") && tc.type !== "function") throw streamProtocolError("tool_call type 异常");
    const fn = tc.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) throw streamProtocolError("tool_call function 结构异常");
    if (typeof fn.name !== "string" || !fn.name) throw streamProtocolError("工具名类型异常");
    if (hasOwn(fn, "arguments")) {
      const a = fn.arguments;
      if (typeof a !== "string" && (a === null || typeof a !== "object" || Array.isArray(a))) {
        throw streamProtocolError("工具参数类型异常");
      }
    }
  }

  /** 审查四③ / 五 B：单条 tool delta 严格校验——index/id/type/function/name/arguments
   *  只要键出现就必须类型正确；显式 null（如 function:null、arguments:null）判协议异常，
   *  绝不当成「本片没带」而沿用之前累积的参数去执行 */
  function validateToolDelta(tc) {
    if (!tc || typeof tc !== "object" || Array.isArray(tc)) throw streamProtocolError("tool_call 结构异常");
    if (hasOwn(tc, "index") && !(Number.isSafeInteger(tc.index) && tc.index >= 0 && tc.index < 1024)) {
      throw streamProtocolError("tool_call index 异常");
    }
    if (hasOwn(tc, "id") && typeof tc.id !== "string") throw streamProtocolError("tool_call id 异常");
    if (hasOwn(tc, "type") && tc.type !== "function") throw streamProtocolError("tool_call type 异常");
    if (hasOwn(tc, "function")) {
      const fn = tc.function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) throw streamProtocolError("tool_call function 结构异常");
      if (hasOwn(fn, "name") && typeof fn.name !== "string") throw streamProtocolError("工具名类型异常");
      if (hasOwn(fn, "arguments") && typeof fn.arguments !== "string") {
        throw streamProtocolError("工具参数片段不是字符串");
      }
    }
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

  /**
   * 只有这些旧款 Claude 接受 temperature 与 tool_choice:any。更新的型号（Opus 4.7 起、Fable、
   * Sonnet/Haiku 5.x）对任何非默认 temperature 返回 400，且常开思考，强制工具调用同样会被拒绝。
   */
  const ANTHROPIC_LEGACY_SAMPLING = /^claude-(?:sonnet-4-6|haiku-4-5)(?:-\d{8})?$/i;
  function anthropicAcceptsSampling(model) {
    return ANTHROPIC_LEGACY_SAMPLING.test(String(model || ""));
  }

  function toAnthropicToolChoice(choice, model) {
    if (choice === "required") {
      if (anthropicAcceptsSampling(model)) return { type: "any" };
      // 降级成 auto 会悄悄改变语义：调用方要求必须调工具，模型却可以直接回文字
      const err = new Error(`${model} 不支持强制工具调用（tool_choice: required）`);
      err.code = "UNSUPPORTED_TOOL_CHOICE";
      throw err;
    }
    if (choice === "none") return { type: "none" };
    return { type: "auto" };
  }

  // pause_turn 不在表里：原样透传，按“未知结束原因”处理——文本照常返回，工具调用失败关闭
  const ANTHROPIC_STOP = {
    end_turn: "stop",
    stop_sequence: "stop",
    tool_use: "tool_calls",
    max_tokens: "length",
    refusal: "content_filter",
  };

  /** stop_reason → OpenAI finish_reason；非字符串交给 normalizeFinishReason 判协议异常 */
  function anthropicFinish(raw) {
    if (typeof raw === "string" && hasOwn(ANTHROPIC_STOP, raw)) return ANTHROPIC_STOP[raw];
    return raw;
  }

  function isPlainObject(v) {
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
  }

  /** 校验 tool_use 块的 id / name；结构不对就整轮失败，绝不拼出半截调用去执行 */
  function assertToolUseBlock(block) {
    if (typeof block.id !== "string" || typeof block.name !== "string" || !block.name) {
      throw streamProtocolError("tool_use 块结构异常");
    }
  }

  /**
   * Anthropic 非流式 JSON → OpenAI choices 形状，让现有解析与校验路径复用。
   * 调用方已排除错误体与非对象；这里对块结构失败关闭。
   */
  function anthropicToOpenAI(data) {
    if (!Array.isArray(data.content)) throw streamProtocolError("content 结构异常");
    const texts = [];
    let reasoning = "";
    const calls = [];
    for (const b of data.content) {
      if (!isPlainObject(b)) throw streamProtocolError("content 块结构异常");
      if (b.type === "text") {
        if (typeof b.text !== "string") throw streamProtocolError("text 块类型异常");
        texts.push(b.text);
      } else if (b.type === "thinking") {
        if (hasOwn(b, "thinking") && typeof b.thinking !== "string") {
          throw streamProtocolError("thinking 块类型异常");
        }
        reasoning += b.thinking || "";
      } else if (b.type === "tool_use") {
        assertToolUseBlock(b);
        const input = b.input == null ? {} : b.input;
        if (!isPlainObject(input)) throw streamProtocolError("工具参数类型异常");
        calls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(input) },
        });
      }
      // redacted_thinking / server_tool_use 等：不含客户端可执行内容，忽略
    }
    const msg = { role: "assistant", content: texts.join(""), tool_calls: calls };
    if (reasoning) msg.reasoning_content = reasoning;
    return {
      model: typeof data.model === "string" ? data.model : undefined,
      choices: [{ message: msg, finish_reason: anthropicFinish(data.stop_reason) }],
    };
  }

  const ANTHROPIC_STREAM_END = { done: true };

  /**
   * Anthropic SSE 事件 → OpenAI delta 形状，喂给 applyDelta（其中的 validateToolDelta /
   * 大小上限照常生效）。message_stop 等价于 [DONE]；字段类型不对一律协议异常。
   * 返回 null 表示与本客户端无关的事件（message_start / content_block_stop / ping / 新增类型）。
   */
  function anthropicEventDelta(evt, state = { seededTools: new Set() }) {
    if (evt.type === "message_stop") return ANTHROPIC_STREAM_END;
    if (evt.type === "content_block_start") {
      const block = evt.content_block;
      if (!isPlainObject(block)) throw streamProtocolError("content_block 结构异常");
      if (block.type === "tool_use") {
        assertToolUseBlock(block);
        const input = block.input == null ? {} : block.input;
        if (!isPlainObject(input)) throw streamProtocolError("工具参数类型异常");
        const fn = { name: block.name };
        // 有的网关在 start 里直接给完整 input、不再发 input_json_delta
        if (Object.keys(input).length) {
          fn.arguments = JSON.stringify(input);
          state.seededTools.add(evt.index);
        }
        return {
          delta: {
            tool_calls: [{
              index: evt.index,
              id: block.id,
              type: "function",
              function: fn,
            }],
          },
        };
      }
      if (block.type === "text") {
        if (hasOwn(block, "text") && typeof block.text !== "string") {
          throw streamProtocolError("text 块类型异常");
        }
        return block.text ? { delta: { content: block.text } } : null;
      }
      return null;
    }
    if (evt.type === "content_block_delta") {
      const d = evt.delta;
      if (!isPlainObject(d)) throw streamProtocolError("delta 结构异常");
      if (d.type === "text_delta") {
        if (typeof d.text !== "string") throw streamProtocolError("text_delta 类型异常");
        return { delta: { content: d.text } };
      }
      if (d.type === "thinking_delta") {
        if (typeof d.thinking !== "string") throw streamProtocolError("thinking_delta 类型异常");
        return { delta: { reasoning_content: d.thinking } };
      }
      if (d.type === "input_json_delta") {
        // start 已给完整参数时再来非空片段，拼接只会得到两份 JSON：判冲突、失败关闭
        if (state.seededTools.has(evt.index) && d.partial_json !== "") {
          throw streamProtocolError("工具参数与 content_block_start.input 冲突");
        }
        // 没有 index 的参数片段无法归属到具体调用：validateToolDelta 会判协议异常
        return {
          delta: {
            tool_calls: [{ index: evt.index, function: { arguments: d.partial_json } }],
          },
        };
      }
      return null; // signature_delta 等
    }
    if (evt.type === "message_delta") {
      const d = evt.delta == null ? {} : evt.delta;
      if (!isPlainObject(d)) throw streamProtocolError("message_delta 结构异常");
      return { delta: {}, finish: anthropicFinish(d.stop_reason) };
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
    const endpoint = chatEndpoint(provider, base, model);
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
      const legacy = anthropicAcceptsSampling(model);
      // Anthropic Messages 规定 max_tokens 必填。新款常开思考，思考 token 也计入 max_tokens，
      // 按正文预算给会频繁 stop_reason=max_tokens，工具调用随之被失败关闭丢弃。
      body = {
        model,
        messages: converted,
        stream: Boolean(stream),
        max_tokens: legacy ? maxTokens : Math.max(maxTokens, LIMITS.anthropicThinkingMaxTokens),
      };
      // top_p / top_k 从不发送：新款同样拒绝，旧款也不需要
      if (legacy && provider.samplingParams !== false) {
        body.temperature = clampNumber(temperature, 0, 1, 0.4);
      }
      if (system) body.system = system;
      if (tools?.length) {
        body.tools = toAnthropicTools(tools);
        body.tool_choice = toAnthropicToolChoice(tool_choice, model);
      }
    } else {
      body = {
        model,
        messages: clipped,
        stream: Boolean(stream),
      };
      if (provider.samplingParams !== false) {
        body.temperature = clampNumber(temperature, 0, 2, 0.4);
        body.max_tokens = maxTokens;
      }
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
      model,
      dispose() {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onParent);
      },
      signal: linkAc.signal,
    };
  }

  /**
   * OpenAI 兼容服务在 HTTP 200 的流里也可能下发 {"error": …}（上游限流、内容审核、中途崩溃）。
   * 这种流必须整体判失败：之前累计的工具调用一条都不能执行。
   */
  function streamPayloadError(json) {
    const raw = json && typeof json === "object" ? json.error : null;
    if (raw == null || raw === false) return null;
    const detail =
      typeof raw === "string"
        ? raw
        : typeof raw?.message === "string"
          ? raw.message
          : "";
    const err = new Error(
      "AI 服务在回复中途报错" + (detail ? "：" + redactSecrets(detail).slice(0, 200) : "")
    );
    err.code = "STREAM_ERROR";
    const status = Number(raw?.code ?? raw?.status);
    if (Number.isFinite(status) && status >= 400 && status < 600) err.status = status;
    return err;
  }

  /** 读正文但不超过 maxChars；超出返回 null。能流式读时超限即取消，不把整个响应读进内存 */
  async function readTextCapped(res, maxChars) {
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      return text.length > maxChars ? null : text;
    }
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > maxChars) return null;
      }
      text += decoder.decode();
      return text.length > maxChars ? null : text;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
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
    // 服务端声明的实际模型（Factory 中转回包里的 model 即实际运行的 droid 模型）
    let respModel = "";
    const anthropicState = { seededTools: new Set() };
    const noteModel = (m) => {
      if (!respModel && typeof m === "string" && MODEL_ID_RE.test(m)) respModel = m;
    };

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
      const fin = normalizeFinishReason(choiceFinish);
      if (fin) finishReason = fin;
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
          validateToolDelta(tc);
          const idx = tc.index == null ? 0 : tc.index;
          if (!toolMap[idx]) {
            if (Object.keys(toolMap).length >= LIMITS.maxToolCallsPerResponse) {
              const err = new Error("工具调用数量超过上限");
              err.code = "RESPONSE_TOO_LARGE";
              throw err;
            }
            toolMap[idx] = { function: { name: "", arguments: "" } };
          }
          const slot = toolMap[idx];
          if (tc.id) {
            // 同一 index 中途换 id：说明分片错乱，不能把两次调用的参数拼在一起执行
            if (slot.id && slot.id !== tc.id) throw streamProtocolError("同一工具调用的 id 前后不一致");
            slot.id = tc.id;
          }
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

    /** 内部断言失败（字段类型异常导致的 TypeError 等）一律视为协议异常、失败关闭 */
    const normalizeStreamError = (err) => {
      if (isAbortLike(err)) return err;
      if (err && typeof err.code === "string" && err.code) return err;
      return streamProtocolError(err?.message ? String(err.message).slice(0, 80) : "未知");
    };

    /**
     * 处理一个完整 SSE 事件。失败关闭：错误事件 / 无法解析 / 结构异常都会 throw，
     * 上层据此整轮判失败，已累计的 tool_calls 一条也不会交给 agent-loop 执行。
     */
    const applyEvent = (evt, parser) => {
      const raw = String(evt?.data ?? "");
      const trimmed = raw.trim();
      if (evt.type !== "error") {
        if (trimmed === "[DONE]") {
          parser.done = true;
          return;
        }
        if (!trimmed) return; // 空 data 保活
      }
      let json = null;
      let parsed = false;
      if (trimmed) {
        try {
          json = JSON.parse(raw);
          parsed = true;
        } catch {
          parsed = false;
        }
      }
      const evtErr = sseEventError(evt, parsed ? json : null);
      if (evtErr) throw evtErr;
      if (!parsed) throw streamProtocolError("无法解析的数据事件");
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw streamProtocolError("数据事件不是对象");
      }
      if (parser.done) return; // [DONE] 之后的普通数据不再计入（错误事件已在上面拦截）
      noteModel(json.type === "message_start" && isPlainObject(json.message) ? json.message.model : json.model);
      if (style === "anthropic") {
        try {
          const ev = anthropicEventDelta(json, anthropicState);
          if (ev === ANTHROPIC_STREAM_END) {
            parser.done = true;
            return;
          }
          if (ev) applyDelta(ev.delta, ev.finish);
        } catch (err) {
          throw normalizeStreamError(err);
        }
        return;
      }
      if (json.choices == null) return; // usage 等无 choices 的块
      if (!Array.isArray(json.choices)) throw streamProtocolError("choices 结构异常");
      const choice = json.choices[0];
      if (choice == null) return;
      if (typeof choice !== "object") throw streamProtocolError("choice 结构异常");
      const delta = choice.delta == null ? {} : choice.delta;
      if (typeof delta !== "object" || Array.isArray(delta)) throw streamProtocolError("delta 结构异常");
      if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) {
        throw streamProtocolError("tool_calls 结构异常");
      }
      try {
        applyDelta(delta, choice.finish_reason);
      } catch (err) {
        throw normalizeStreamError(err);
      }
    };

    if (!reader) {
      const text = await res.text();
      if (text.length > LIMITS.maxStreamResponseChars) {
        const err = new Error("流式响应超过安全上限");
        err.code = "RESPONSE_TOO_LARGE";
        throw err;
      }
      if (looksLikeSse(text, res)) {
        // 原生 HTTP（CapacitorHttp）缓冲了整段 SSE：同样按完整事件解析，规则与流式一致
        const parser = new SseEventParser();
        try {
          for (const evt of parser.push(text)) applyEvent(evt, parser);
          for (const evt of parser.flush()) applyEvent(evt, parser);
        } catch (err) {
          throw normalizeStreamError(err);
        }
        if (!finishReason && !parser.done) {
          const err = new Error("AI 回复意外中断（流未正常结束），本轮结果已丢弃");
          err.code = "STREAM_INCOMPLETE";
          throw err;
        }
        const tool_calls = finalizeToolCalls(toolMap);
        assertFinishAllowsTools(finishReason, tool_calls);
        if (!finishReason) finishReason = tool_calls.length ? "tool_calls" : "stop";
        return { content, reasoning, tool_calls, finish_reason: finishReason, aborted, timedOut, model: respModel };
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw streamProtocolError("无法解析的响应体");
      }
      const payloadErr = sseEventError(null, data);
      if (payloadErr) throw payloadErr;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw streamProtocolError("响应体不是对象");
      }
      if (style === "anthropic") data = anthropicToOpenAI(data);
      noteModel(data.model);
      const choice = data?.choices?.[0];
      const msg = choice?.message || {};
      if (choice != null && (typeof choice !== "object" || Array.isArray(choice))) {
        throw streamProtocolError("choice 结构异常");
      }
      finishReason = normalizeFinishReason(choice?.finish_reason);
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
          validateBufferedToolCall(tc);
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
      const parser = new SseEventParser();
      let idleTimer = null;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => onStall?.(), LIMITS.streamIdleTimeoutMs);
      };
      try {
        armIdle();
        while (true) {
          if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
            applyEvent(evt, parser);
          }
        }
        for (const evt of parser.push(decoder.decode())) applyEvent(evt, parser);
        for (const evt of parser.flush()) applyEvent(evt, parser);
      } catch (err) {
        if (!isAbortLike(err)) throw normalizeStreamError(err);
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
      // 既没有 finish_reason 也没有 [DONE] 就 EOF：连接被截断，结果不完整。
      // 不能合成为成功，尤其不能执行半截流里累计的工具调用。
      if (!aborted && !finishReason && !parser.done) {
        const err = new Error("AI 回复意外中断（流未正常结束），本轮结果已丢弃");
        err.code = "STREAM_INCOMPLETE";
        throw err;
      }
    }

    const tool_calls = finalizeToolCalls(toolMap);
    // 用户停止/超时的流本来就不会执行工具（agent-loop 硬闸门）；其余一律校验结束状态
    if (!aborted) assertFinishAllowsTools(finishReason, tool_calls);
    if (!finishReason && !aborted) {
      finishReason = tool_calls.length ? "tool_calls" : "stop";
    }
    return { content, reasoning, tool_calls, finish_reason: finishReason, aborted, timedOut, model: respModel };
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
          // false：该服务商不支持 temperature / max_tokens，App 不会发送
          samplingParams: p.samplingParams !== false,
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
      const ac = new AbortController();
      const timer = setTimeout(
        () => ac.abort(new DOMException("请求超时", "TimeoutError")),
        LIMITS.connectTimeoutMs
      );
      try {
        const res = await fetch(`${base}/models`, { method: "GET", headers, signal: ac.signal });
        if (!res.ok) {
          return { ok: true, models: providerModels(p), source: "static", status: res.status };
        }
        const text = await readTextCapped(res, LIMITS.maxModelsResponseChars);
        if (text == null) {
          return { ok: true, models: providerModels(p), source: "static", code: "RESPONSE_TOO_LARGE" };
        }
        const data = JSON.parse(text);
        const arr = Array.isArray(data?.data) ? data.data.slice(0, LIMITS.maxListedModels) : [];
        const remote = arr
          .filter((m) => m && typeof m === "object" && typeof m.id === "string")
          .map((m) => ({
            id: m.id,
            label: (typeof m.name === "string" && m.name ? m.name : m.id).slice(0, 128),
          }))
          .filter((m) => MODEL_ID_RE.test(m.id));
        if (!remote.length) {
          return { ok: true, models: providerModels(p), source: "static" };
        }
        // 用内置列表里的中文别名；列表里没有的远端模型用远端名字
        const known = new Map(providerModels(p).map((m) => [m.id, m.label]));
        const merged = remote.map((m) => ({ id: m.id, label: known.get(m.id) || m.label }));
        return { ok: true, models: merged, source: "remote" };
      } catch {
        return { ok: true, models: providerModels(p), source: "static" };
      } finally {
        clearTimeout(timer);
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
      const endpoint = chatEndpoint(provider, base);
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
            if (looksLikeSse(text, call.res)) {
              // 服务端无视 stream:false 回了 SSE：按完整事件组装，错误/异常同样失败关闭
              const r = await consumeStream(
                { body: null, headers: call.res.headers, text: async () => text },
                null,
                { style: call.style }
              );
              return {
                ok: true,
                requestId,
                model: r.model || call.model,
                message: {
                  role: "assistant",
                  content: r.content || "",
                  reasoning_content: r.reasoning || "",
                  tool_calls: r.tool_calls || [],
                },
                finish_reason: r.finish_reason || null,
              };
            }
            let data;
            try {
              data = JSON.parse(text);
            } catch {
              throw streamProtocolError("无法解析的响应体");
            }
            // HTTP 200 里的 {"error": …} / {"type":"error"} 不是成功回复，不能当成“空回复”放行
            const bodyErr = sseEventError(null, data);
            if (bodyErr) throw bodyErr;
            if (!data || typeof data !== "object" || Array.isArray(data)) {
              throw streamProtocolError("响应体不是对象");
            }
            if (call.style === "anthropic") data = anthropicToOpenAI(data);
            if (data.choices != null && !Array.isArray(data.choices)) {
              throw streamProtocolError("choices 结构异常");
            }
            const choice = data?.choices?.[0] || {};
            if (typeof choice !== "object" || Array.isArray(choice)) throw streamProtocolError("choice 结构异常");
            const msg = choice.message || {};
            if (typeof msg !== "object" || Array.isArray(msg)) throw streamProtocolError("message 结构异常");
            // 审查四②：complete 与流式同一套 finish_reason / tool_calls 校验
            const finish = normalizeFinishReason(choice.finish_reason);
            if (msg.tool_calls != null && !Array.isArray(msg.tool_calls)) {
              throw streamProtocolError("tool_calls 结构异常");
            }
            const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            for (const tc of calls) validateBufferedToolCall(tc);
            assertFinishAllowsTools(finish, calls);
            return {
              ok: true,
              requestId,
              model: typeof data.model === "string" && data.model ? data.model : call.model,
              message: {
                role: "assistant",
                content: msg.content || "",
                reasoning_content: msg.reasoning_content || "",
                tool_calls: calls,
              },
              finish_reason: finish,
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
      const endpoint = chatEndpoint(provider, base);

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
        let finished = false;
        // CapacitorHttp 可能忽略 AbortSignal：停止后原生请求迟迟不返回。
        // 本地必须立刻收尾并释放并发名额，迟到的响应只做清理、不再回调。
        const stopSignal = entry.ac.signal;
        let onStop = null;
        const stopped = new Promise((_, reject) => {
          onStop = () =>
            reject(stopSignal.reason || new DOMException("已停止", "AbortError"));
          if (stopSignal.aborted) onStop();
          else stopSignal.addEventListener("abort", onStop, { once: true });
        });
        stopped.catch(() => {});
        const discardLate = (late) => {
          if (!late || late === link) return;
          try {
            late.dispose?.();
          } catch {
            /* ignore */
          }
          try {
            late.res?.body?.cancel?.()?.catch?.(() => {});
          } catch {
            /* ignore */
          }
        };
        try {
          const callPromise = callChatApi({
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
          callPromise.then(
            (late) => {
              if (finished) discardLate(late);
            },
            () => {}
          );
          const call = await Promise.race([callPromise, stopped]);
          link = call;
          const result = await Promise.race([
            consumeStream(
              call.res,
              (piece) => {
                // 本地已收尾（停止/超时）后，后台还在读的旧流不得再往同 requestId 推数据
                if (!finished) emitDelta(requestId, piece);
              },
              {
                signal: call.signal,
                style: call.style,
                onStall: () =>
                  entry.ac.abort(new DOMException("流已停顿", "TimeoutError")),
              }
            ),
            stopped,
          ]);
          emitDone(requestId, {
            content: result.content,
            reasoning: result.reasoning,
            tool_calls: result.tool_calls,
            finish_reason: result.finish_reason,
            model: result.model || call.model,
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
          // 流内错误/断流保留具体原因（含上游给的错误信息），别被 HTTP 状态分类盖掉
          const streamFailed =
            err?.code === "STREAM_ERROR" ||
            err?.code === "STREAM_INCOMPLETE" ||
            err?.code === "STREAM_TRUNCATED";
          emitError(requestId, streamFailed ? err.message : classified.message);
        } finally {
          finished = true;
          stopSignal.removeEventListener("abort", onStop);
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
        ? "番茄已记录，但 ClickUp 上传结果未确认；稍后会自动核对，不会重复提交"
        : result?.code === "NEEDS_MANUAL_RETRY"
          ? "有番茄打卡长时间未确认，已停止自动补发；可在设置 › ClickUp「重试待核对」"
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
  let retryPendingRun = null;
  window.luminaClickUp = {
    logPomo(payload) {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu) return Promise.resolve({ ok: false, error: "ClickUp 模块未加载", retryable: false });
      const src = payload && typeof payload === "object" ? payload : {};
      let endedAt = Number(src.endedAt);
      if (!Number.isFinite(endedAt) || endedAt <= 0) endedAt = Date.now();
      return cu.logPomodoro({
        title: typeof src.title === "string" ? src.title : "",
        taskId: typeof src.taskId === "string" ? src.taskId : undefined,
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
        // 仅用户在「长时间未确认」提示上点了重新上传时为 true
        manualRetry: src.manualRetry === true,
      });
    },
    retryPending() {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu?.retryPendingPomos) return Promise.resolve({ ok: false, error: "ClickUp 模块未加载" });
      // single-flight：重叠的手动重试共享同一次执行（mobile-clickup 内部另有锁与版本校验）
      if (retryPendingRun) return retryPendingRun;
      const run = Promise.resolve(cu.retryPendingPomos()).then(async (pomo) => {
        let push = null;
        try {
          push = await cu.reconcilePendingPushes();
        } catch {
          push = null;
        }
        return { ok: Boolean(pomo?.ok), pomo, push };
      });
      retryPendingRun = run;
      run.finally(() => {
        if (retryPendingRun === run) retryPendingRun = null;
      }).catch(() => {});
      return run;
    },
    setToken(token) {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu) return Promise.resolve({ ok: false, error: "ClickUp 模块未加载" });
      return Promise.resolve(cu.setStoredToken(token));
    },
    clearFailed() {
      const cu = globalThis.LUMINA_MOBILE_CLICKUP;
      if (!cu?.clearFailedQueue) return Promise.resolve({ ok: false, error: "ClickUp 模块未加载" });
      return Promise.resolve(cu.clearFailedQueue()).then((ok) => ({ ok: ok === true }));
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
