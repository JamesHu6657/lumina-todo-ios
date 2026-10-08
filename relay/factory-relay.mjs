import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const RELAY_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_DROID_OUTPUT = 4 * 1024 * 1024;
const HEADER = [
  "你是「Lumina Todo」App 里的 AI 助手，正在通过一个中转服务回复用户。",
  "你不能使用你自己的任何内置工具：不要读写文件，不要执行命令，不要联网，不要写计划。",
  "下面是到目前为止的完整对话，请只输出 assistant 的下一条回复。",
].join("\n");

class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function positiveInteger(value, fallback, name, allowZero = false) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return n;
}

export function loadConfig(env = process.env) {
  const factoryApiKey = String(env.FACTORY_API_KEY || "").trim();
  if (!factoryApiKey) throw new Error("FACTORY_API_KEY is required");
  const relayToken = String(env.RELAY_TOKEN || "");
  if (Buffer.byteLength(relayToken) < 24) {
    throw new Error("RELAY_TOKEN must contain at least 24 bytes");
  }
  const droidModel = String(env.DROID_MODEL || "deepseek-v4.1-flash").trim();
  if (!droidModel) throw new Error("DROID_MODEL must not be empty");
  const allowedModels = env.ALLOWED_MODELS == null
    ? [droidModel]
    : String(env.ALLOWED_MODELS).split(",").map((model) => model.trim()).filter(Boolean);
  return {
    factoryApiKey,
    relayToken,
    host: String(env.HOST || "127.0.0.1"),
    port: positiveInteger(env.PORT, 8787, "PORT", true),
    droidBin: String(env.DROID_BIN || "droid"),
    droidModel,
    allowedModels,
    droidReasoning: String(env.DROID_REASONING || ""),
    maxConcurrency: positiveInteger(env.MAX_CONCURRENCY, 2, "MAX_CONCURRENCY"),
    timeoutMs: positiveInteger(env.TIMEOUT_MS, 90000, "TIMEOUT_MS"),
    maxBodyBytes: positiveInteger(env.MAX_BODY_BYTES, 1024 * 1024, "MAX_BODY_BYTES"),
    maxRequestsPerMinute: positiveInteger(
      env.MAX_REQUESTS_PER_MINUTE,
      30,
      "MAX_REQUESTS_PER_MINUTE",
      true
    ),
  };
}

function contentText(content) {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function parseOrRaw(value) {
  if (typeof value !== "string") return value ?? "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolChoiceName(toolChoice) {
  return toolChoice?.type === "function" ? toolChoice.function?.name : null;
}

function renderToolsSection(tools, toolChoice) {
  const renderedTools = tools.map((tool) => ({
    name: tool?.function?.name,
    description: tool?.function?.description || "",
    parameters: tool?.function?.parameters || {},
  }));
  const lines = [
    "App 提供了下面这些工具，由 App 在用户手机上替你执行：",
    "<tools>",
    JSON.stringify(renderedTools),
    "</tools>",
    "",
    "需要调用工具时，整条回复只输出一个 <tool_calls> 块，块里是 JSON 数组，块外不要有任何文字：",
    '<tool_calls>[{"name":"工具名","arguments":{"参数名":"参数值"}}]</tool_calls>',
    "可以在一个数组里一次调用多个工具。arguments 必须是符合该工具 parameters 的 JSON 对象。",
    "工具执行结果会以 [tool_result] 的形式出现在后续对话里。",
    "不需要调用工具时，直接回复用户，不要输出 <tool_calls>。",
  ];
  if (toolChoice === "required") lines.push("本轮必须调用工具。");
  const requiredName = toolChoiceName(toolChoice);
  if (requiredName) lines.push(`本轮必须调用工具 ${requiredName}。`);
  return lines.join("\n");
}

function renderTranscript(messages) {
  const callNames = new Map();
  for (const message of messages) {
    for (const call of message?.tool_calls || []) {
      if (call?.id) callNames.set(call.id, call?.function?.name || "unknown");
    }
  }

  const blocks = [];
  for (const message of messages) {
    const role = message.role;
    const content = contentText(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (content) blocks.push(`[assistant]\n${content}`);
      const calls = message.tool_calls.map((call) => ({
        name: call?.function?.name || "",
        arguments: parseOrRaw(call?.function?.arguments),
      }));
      blocks.push(`[assistant tool_calls]\n<tool_calls>${JSON.stringify(calls)}</tool_calls>`);
    } else if (role === "tool") {
      const name = callNames.get(message.tool_call_id) || "unknown";
      blocks.push(`[tool_result name=${name}]\n${content}`);
    } else {
      blocks.push(`[${role}]\n${content}`);
    }
  }
  return blocks.join("\n\n");
}

export function renderPrompt({ messages, tools = [], tool_choice: toolChoice } = {}) {
  const sections = [HEADER];
  if (tools.length && toolChoice !== "none") {
    sections.push(renderToolsSection(tools, toolChoice));
  }
  sections.push(renderTranscript(messages));
  sections.push("[assistant]");
  return sections.join("\n\n");
}

function redactFactoryKey(message) {
  return String(message || "Droid 执行失败").replace(/fk-[A-Za-z0-9_-]+/g, "[已隐藏]");
}

function errorBody(message) {
  return {
    error: {
      message: redactFactoryKey(message),
      type: "invalid_request_error",
    },
  };
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function sendError(res, status, message) {
  sendJson(res, status, errorBody(message));
}

function authorized(req, expectedToken) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function readJson(req, maxBytes) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new RelayError(413, "Request body is too large");
  }
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.resume();
        reject(new RelayError(413, "Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", resolve);
    req.once("error", reject);
    req.once("aborted", () => reject(new RelayError(400, "Request body was interrupted")));
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RelayError(400, "Request body must be valid JSON");
  }
}

function validateChatBody(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    throw new RelayError(400, "messages must be an array");
  }
  for (const message of body.messages) {
    if (!message || !["system", "user", "assistant", "tool"].includes(message.role)) {
      throw new RelayError(400, "messages contains an unsupported role");
    }
  }
}

function lastResultLine(stdout) {
  let result = null;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "result") result = parsed;
    } catch {
      /* Ignore progress and non-JSON lines. */
    }
  }
  return result;
}

function toolDefinitions(requestTools) {
  return Array.isArray(requestTools) ? requestTools : [];
}

function parseToolCalls(text, tools, toolChoice) {
  if (!tools.length || toolChoice === "none") return null;
  const match = /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/.exec(text);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const names = new Set(
    tools.map((tool) => tool?.function?.name).filter((name) => typeof name === "string")
  );
  if (
    !parsed.every((call) => {
      const args = call?.arguments;
      return (
        typeof call?.name === "string" &&
        names.has(call.name) &&
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args)
      );
    })
  ) {
    return null;
  }
  return parsed.map((call) => ({
    id: `call_${crypto.randomBytes(8).toString("hex")}`,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }));
}

function usageFromDroid(usage = {}) {
  const promptTokens = Number(
    usage.inputTokens ?? usage.input_tokens ?? usage.input ?? usage.prompt_tokens ?? 0
  ) || 0;
  const completionTokens = Number(
    usage.outputTokens ?? usage.output_tokens ?? usage.output ?? usage.completion_tokens ?? 0
  ) || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function openAiId() {
  return `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
}

function writeChunk(res, id, created, model, delta, finishReason = null) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function sendCompletion(res, body, model, text, calls, droidResult) {
  const id = openAiId();
  const created = Math.floor(Date.now() / 1000);
  const finishReason = calls ? "tool_calls" : "stop";
  const message = calls
    ? { role: "assistant", content: null, tool_calls: calls }
    : { role: "assistant", content: text };
  const usage = usageFromDroid(droidResult.usage);
  if (body.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    writeChunk(res, id, created, model, { role: "assistant" });
    if (calls) {
      writeChunk(
        res,
        id,
        created,
        model,
        {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: call.type,
            function: call.function,
          })),
        }
      );
    } else {
      writeChunk(res, id, created, model, { content: text });
    }
    writeChunk(res, id, created, model, {}, finishReason);
    res.end("data: [DONE]\n\n");
    return;
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  });
}

function childEnvironment(factoryApiKey) {
  const env = {
    FACTORY_API_KEY: factoryApiKey,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
  };
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

async function runDroid(config, sandboxDir, prompt, model, req, res) {
  const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-relay-prompt-"));
  const promptFile = path.join(promptDir, "prompt.txt");
  try {
    await fs.writeFile(promptFile, prompt, { mode: 0o600 });
    const args = [
      "exec",
      "-m",
      model,
      "--only-tools",
      "TodoWrite",
      "--disable-builtin-skills",
      "-o",
      "json",
      "--cwd",
      sandboxDir,
      "-f",
      promptFile,
    ];
    if (config.droidReasoning) args.push("-r", config.droidReasoning);

    let child;
    let timedOut = false;
    let disconnected = false;
    let overflow = false;
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let timeout = null;
    let settled = false;
    const listeners = [];
    const result = await new Promise((resolve, reject) => {
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        for (const [target, event, handler] of listeners) target.removeListener(event, handler);
        if (err) reject(err);
        else resolve(value);
      };
      const kill = () => {
        if (child && !child.killed) child.kill("SIGKILL");
      };
      const onAbort = () => {
        disconnected = true;
        kill();
      };
      const onClose = () => {
        if (!res.writableEnded) {
          disconnected = true;
          kill();
        }
      };
      req.once("aborted", onAbort);
      res.once("close", onClose);
      listeners.push([req, "aborted", onAbort], [res, "close", onClose]);
      try {
        child = spawn(config.droidBin, args, {
          stdio: ["ignore", "pipe", "ignore"],
          env: childEnvironment(config.factoryApiKey),
        });
      } catch (err) {
        finish(err);
        return;
      }
      // 按字节累计、结束后一次性解码：逐块 toString 会把跨块的多字节汉字解成乱码
      child.stdout.on("data", (chunk) => {
        if (overflow) return;
        if (stdoutBytes + chunk.length > MAX_DROID_OUTPUT) {
          overflow = true;
          kill();
          return;
        }
        stdoutBytes += chunk.length;
        stdoutChunks.push(chunk);
      });
      child.once("error", (err) => finish(err));
      child.once("close", (code, signal) => finish(null, { code, signal }));
      timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, config.timeoutMs);
    });
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    return { ...result, timedOut, disconnected, overflow, stdout };
  } finally {
    await fs.rm(promptDir, { recursive: true, force: true });
  }
}

export function createRelayServer(config = loadConfig()) {
  const sandboxDir = fs.mkdtemp(path.join(os.tmpdir(), "factory-relay-sandbox-"));
  // 创建失败时由请求里的 await 报 502；这里只防止启动期未处理的 rejection 直接拖垮进程
  sandboxDir.catch(() => {});
  let active = 0;
  let recentStarts = [];

  function rateLimited() {
    if (!config.maxRequestsPerMinute) return false;
    const now = Date.now();
    recentStarts = recentStarts.filter((at) => now - at < 60_000);
    if (recentStarts.length >= config.maxRequestsPerMinute) return true;
    recentStarts.push(now);
    return false;
  }

  const server = http.createServer((req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    void (async () => {
      // 不用 new URL()：未鉴权的 "//a:99999/" 这类路径会让它抛错，进而让整个进程退出
      const pathname = String(req.url || "/").split("?")[0];
      if (req.method === "GET" && pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }
      if (
        req.method === "GET" &&
        pathname === "/v1/models"
      ) {
        if (!authorized(req, config.relayToken)) {
          sendError(res, 401, "Invalid bearer token");
          return;
        }
        sendJson(res, 200, {
          object: "list",
          data: config.allowedModels.map((id) => ({ id, object: "model", owned_by: "factory" })),
        });
        return;
      }
      if (req.method !== "POST" || pathname !== "/v1/chat/completions") {
        sendError(res, 404, "Not found");
        return;
      }
      if (!authorized(req, config.relayToken)) {
        sendError(res, 401, "Invalid bearer token");
        return;
      }
      if (active >= config.maxConcurrency) {
        sendError(res, 429, "Too many concurrent requests");
        return;
      }
      if (rateLimited()) {
        sendError(res, 429, "Too many requests per minute");
        return;
      }
      active++;
      try {
        const body = await readJson(req, config.maxBodyBytes);
        validateChatBody(body);
        const model = config.allowedModels.includes(body.model)
          ? body.model
          : config.droidModel;
        const tools = toolDefinitions(body.tools);
        const prompt = renderPrompt({
          messages: body.messages,
          tools,
          tool_choice: body.tool_choice,
        });
        const droid = await runDroid(config, await sandboxDir, prompt, model, req, res);
        if (droid.disconnected || res.destroyed) return;
        if (droid.timedOut) {
          sendError(res, 504, "Droid execution timed out");
          return;
        }
        if (droid.overflow) {
          sendError(res, 502, "Droid output exceeded the limit");
          return;
        }
        if (droid.code !== 0) {
          sendError(res, 502, "Droid execution failed");
          return;
        }
        const result = lastResultLine(droid.stdout);
        if (!result) {
          sendError(res, 502, "Droid returned no result");
          return;
        }
        if (result.is_error) {
          sendError(res, 502, redactFactoryKey(result.result || "Droid execution failed"));
          return;
        }
        const text = String(result.result ?? "");
        const calls = parseToolCalls(text, tools, body.tool_choice);
        sendCompletion(res, body, model, text, calls, result);
      } catch (err) {
        if (res.destroyed || res.writableEnded) return;
        const status = err instanceof RelayError ? err.status : 502;
        sendError(res, status, err instanceof RelayError ? err.message : "Droid execution failed");
      } finally {
        active--;
      }
    })().catch(() => {
      // 兜底：任何漏网异常只影响本次请求，不能变成未处理 rejection 让服务退出
      if (!res.headersSent && !res.destroyed) sendError(res, 500, "Internal relay error");
      else if (!res.writableEnded) res.destroy();
    });
  });
  server.on("close", () => {
    // sandboxDir 是 Promise，直接传给 fs.rm 会抛 TypeError，关停时进程以 1 退出且目录残留
    void sandboxDir
      .then((dir) => fs.rm(dir, { recursive: true, force: true }))
      .catch(() => {});
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const config = loadConfig();
    const server = createRelayServer(config);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      process.stdout.write(`Factory relay listening on ${config.host}:${address.port}\n`);
    });
    const shutdown = () => server.close();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
