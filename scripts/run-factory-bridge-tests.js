/**
 * Factory 中转 × iOS 桥接回归测试（Node，无真机）
 * 中转要等 droid exec 整轮结束才回包，CapacitorHttp 又会缓冲整个响应：
 * 流式 chat 必须给足等待时间，不能沿用 30s 连接超时。
 * 计时器按 1/1000 缩放：1ms ≈ 真机 1s。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const WWW = path.join(__dirname, "..", "www");
const SCALE = 1000;

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function sseBody(text) {
  const frames = [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const raw = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(raw);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** 模拟中转：relaySeconds 后才一次性回完整 SSE；尊重 AbortSignal */
function slowRelayFetch(relaySeconds, text) {
  return (_url, options) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ ok: true, status: 200, body: sseBody(text) }),
        (relaySeconds * 1000) / SCALE
      );
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        },
        { once: true }
      );
    });
}

function loadBridge(store, fetchImpl) {
  const sandbox = {
    console: { ...console, error() {} },
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms / SCALE, ...args),
    clearTimeout,
    fetch: fetchImpl,
    localStorage: store,
    AbortController,
    URL,
    TextDecoder,
    ReadableStream,
    DOMException: class DOMException extends Error {
      constructor(msg, name) {
        super(msg);
        this.name = name || "DOMException";
      }
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-bridge.js"), "utf8"), sandbox);
  return sandbox.luminaAI;
}

function runChat(ai) {
  return new Promise((resolve) => {
    ai.chat(
      { messages: [{ role: "user", content: "hi" }] },
      {
        onDone: (data) => resolve({ done: data }),
        onError: (error) => resolve({ error }),
      }
    );
  });
}

async function main() {
  const store = makeLocalStorage();
  store.setItem("lumina-api-provider", "factory");
  store.setItem("lumina-api-key-factory", "relay-token-" + "f".repeat(24));
  store.setItem("lumina-factory-base", "https://relay.example.com/v1");

  // droid 跑了 60s 才回包：超过 30s 连接超时，但在中转自身 90s 上限内
  const ai = loadBridge(store, slowRelayFetch(60, "慢回复"));
  await new Promise((r) => setTimeout(r, 10));
  const result = await runChat(ai);
  assert.equal(result.error, undefined, `不应报错：${result.error}`);
  assert.equal(result.done.aborted, undefined, "不应被超时中止");
  assert.equal(result.done.content, "慢回复");
  console.log("✔ Factory 流式 chat 能等到 60s 才回包的中转响应");

  // 中转卡死时客户端仍要自行收尾，不能无限挂起
  const stuck = loadBridge(store, slowRelayFetch(600, "never"));
  await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  const stuckResult = await runChat(stuck);
  assert.ok(stuckResult.error || stuckResult.done?.aborted, "卡死的中转必须以超时收尾");
  assert.ok(Date.now() - started < 200, "超时须在 ~120s（缩放后 120ms）内触发");
  console.log("✔ Factory 中转卡死时仍会超时收尾");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
