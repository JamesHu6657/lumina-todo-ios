import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig, renderPrompt } from "./factory-relay.mjs";

const relayFile = fileURLToPath(new URL("./factory-relay.mjs", import.meta.url));
const fixtureFile = fileURLToPath(new URL("./test-fixtures/stub-droid.mjs", import.meta.url));
const token = "relay-test-token-that-is-long-enough";
const testTools = [{
  type: "function",
  function: {
    name: "add_todo",
    description: "Create a todo",
    parameters: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
}];
const failures = [];

async function test(name, callback) {
  try {
    await callback();
    process.stdout.write(`✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stderr.write(`✗ ${name}: ${error.stack || error}\n`);
  }
}

async function startRelay(overrides = {}) {
  const child = spawn(process.execPath, [relayFile], {
    env: {
      ...process.env,
      FACTORY_API_KEY: "test-factory-key",
      RELAY_TOKEN: token,
      HOST: "127.0.0.1",
      PORT: "0",
      DROID_BIN: fixtureFile,
      DROID_MODEL: "deepseek-v4.1-flash",
      ALLOWED_MODELS: "deepseek-v4.1-flash,custom-model",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Relay startup timed out: ${stderr}`)), 5000);
    const onData = () => {
      const match = stdout.match(/Factory relay listening on 127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.removeListener("data", onData);
      resolve(`http://127.0.0.1:${match[1]}`);
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Relay exited during startup (${code}): ${stderr}`));
    });
  });
  return {
    address,
    child,
    async close() {
      if (child.exitCode == null && child.signalCode == null) {
        await new Promise((resolve) => {
          child.once("exit", resolve);
          child.kill("SIGTERM");
        });
      }
    },
  };
}

function request(relay, route, { method = "GET", body, auth = token, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (auth !== null) requestHeaders.Authorization = `Bearer ${auth}`;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  return fetch(`${relay.address}${route}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawRequestLine(relay, target) {
  const { hostname, port } = new URL(relay.address);
  return new Promise((resolve) => {
    let received = "";
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: relay.test\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("error", () => {});
    socket.on("close", () => resolve(received.split("\r\n")[0] || ""));
    setTimeout(() => socket.destroy(), 1000);
  });
}

async function withRelay(overrides, callback) {
  const relay = await startRelay(overrides);
  try {
    await callback(relay);
  } finally {
    await relay.close();
  }
}

await test("configuration requires Factory and relay credentials", () => {
  assert.throws(() => loadConfig({ RELAY_TOKEN: token }), /FACTORY_API_KEY is required/);
  assert.throws(() => loadConfig({ FACTORY_API_KEY: "test", RELAY_TOKEN: "short" }), /RELAY_TOKEN/);
});

await withRelay({}, async (relay) => {
  await test("health check is public and CORS preflight needs no auth", async () => {
    const health = await request(relay, "/healthz", { auth: null });
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    const options = await request(relay, "/v1/chat/completions", { method: "OPTIONS", auth: null });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    assert.equal(options.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
    assert.equal(options.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  });

  await test("missing and incorrect bearer tokens return OpenAI errors", async () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    for (const auth of [null, "wrong-token"]) {
      const response = await request(relay, "/v1/chat/completions", { method: "POST", body, auth });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.type, "invalid_request_error");
    }
  });

  await test("authenticated model list contains allowed models", async () => {
    const response = await request(relay, "/v1/models");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [
      { id: "deepseek-v4.1-flash", object: "model", owned_by: "factory" },
      { id: "custom-model", object: "model", owned_by: "factory" },
    ]);
  });

  await test("prompt rendering preserves tools and the full tagged transcript", async () => {
    const body = {
      model: "custom-model",
      messages: [
        { role: "system", content: "Follow user instructions." },
        {
          role: "user",
          content: [
            { type: "text", text: "开始" },
            { type: "image_url", image_url: { url: "ignored" } },
            { type: "text", text: "STUB:CAPTURE" },
          ],
        },
        {
          role: "assistant",
          content: "我会调用。",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "add_todo", arguments: '{"title":"牛奶"}' },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "已添加" },
      ],
      tools: testTools,
      tool_choice: "required",
    };
    const expectedPrompt = [
      [
        "你是「Lumina Todo」App 里的 AI 助手，正在通过一个中转服务回复用户。",
        "你不能使用你自己的任何内置工具：不要读写文件，不要执行命令，不要联网，不要写计划。",
        "下面是到目前为止的完整对话，请只输出 assistant 的下一条回复。",
      ].join("\n"),
      [
        "App 提供了下面这些工具，由 App 在用户手机上替你执行：",
        "<tools>",
        JSON.stringify([{
          name: "add_todo",
          description: "Create a todo",
          parameters: testTools[0].function.parameters,
        }]),
        "</tools>",
        "",
        "需要调用工具时，整条回复只输出一个 <tool_calls> 块，块里是 JSON 数组，块外不要有任何文字：",
        '<tool_calls>[{"name":"工具名","arguments":{"参数名":"参数值"}}]</tool_calls>',
        "可以在一个数组里一次调用多个工具。arguments 必须是符合该工具 parameters 的 JSON 对象。",
        "工具执行结果会以 [tool_result] 的形式出现在后续对话里。",
        "不需要调用工具时，直接回复用户，不要输出 <tool_calls>。",
        "本轮必须调用工具。",
      ].join("\n"),
      [
        "[system]\nFollow user instructions.",
        "[user]\n开始\nSTUB:CAPTURE",
        "[assistant]\n我会调用。",
        `[assistant tool_calls]\n<tool_calls>${JSON.stringify([{ name: "add_todo", arguments: { title: "牛奶" } }])}</tool_calls>`,
        "[tool_result name=add_todo]\n已添加",
        "[assistant]",
      ].join("\n\n"),
    ].join("\n\n");
    assert.equal(renderPrompt(body), expectedPrompt);
    const response = await request(relay, "/v1/chat/completions", { method: "POST", body });
    assert.equal(response.status, 200);
    const parsed = await response.json();
    const captured = JSON.parse(parsed.choices[0].message.content);
    assert.equal(captured.prompt, expectedPrompt);
    assert.equal(captured.factoryKeyPresent, true);
    assert.equal(captured.promptMode, 0o600);
    assert.ok(captured.args.includes("--only-tools"));
    assert.ok(captured.args.includes("TodoWrite"));
    assert.ok(!captured.args.includes("--auto"));
    assert.ok(!captured.args.includes("--skip-permissions-unsafe"));
    assert.equal(captured.args[captured.args.indexOf("-m") + 1], "custom-model");
    const sandboxDir = captured.args[captured.args.indexOf("--cwd") + 1];
    assert.deepEqual(await fs.readdir(sandboxDir), []);
    const promptFile = captured.args[captured.args.indexOf("-f") + 1];
    await assert.rejects(fs.access(promptFile));
  });

  await test("non-stream response has OpenAI shape and mapped usage", async () => {
    const response = await request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "STUB:PLAIN" }] },
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.match(result.id, /^chatcmpl-/);
    assert.equal(result.object, "chat.completion");
    assert.equal(result.model, "deepseek-v4.1-flash");
    assert.equal(result.choices[0].message.content, "plain reply");
    assert.equal(result.choices[0].finish_reason, "stop");
    assert.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  await test("valid tool calls are parsed and invalid calls remain plain content", async () => {
    for (const marker of ["TOOL-VALID", "TOOL-UNKNOWN", "TOOL-MALFORMED", "TOOL-NONE"]) {
      const response = await request(relay, "/v1/chat/completions", {
        method: "POST",
        body: {
          messages: [{ role: "user", content: `STUB:${marker}` }],
          tools: testTools,
          tool_choice: marker === "TOOL-NONE" ? "none" : "auto",
        },
      });
      const result = await response.json();
      if (marker === "TOOL-VALID") {
        assert.equal(result.choices[0].finish_reason, "tool_calls");
        assert.equal(result.choices[0].message.content, null);
        assert.equal(result.choices[0].message.tool_calls[0].function.name, "add_todo");
        assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), {
          title: "买牛奶",
        });
      } else {
        assert.equal(result.choices[0].finish_reason, "stop");
        assert.match(result.choices[0].message.content, /<tool_calls>/);
      }
    }
  });

  await test("stream response emits role, content, finish, and DONE chunks", async () => {
    const response = await request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "STUB:STREAM" }], stream: true },
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const frames = (await response.text()).trim().split("\n\n").map((frame) => frame.slice(6));
    assert.equal(frames.length, 4);
    assert.deepEqual(JSON.parse(frames[0]).choices[0].delta, { role: "assistant" });
    assert.deepEqual(JSON.parse(frames[1]).choices[0].delta, { content: "streamed hello" });
    assert.equal(JSON.parse(frames[2]).choices[0].finish_reason, "stop");
    assert.equal(frames[3], "[DONE]");
  });

  await test("streamed tool calls are emitted as tool-call deltas", async () => {
    const response = await request(relay, "/v1/chat/completions", {
      method: "POST",
      body: {
        messages: [{ role: "user", content: "STUB:TOOL-VALID" }],
        tools: testTools,
        stream: true,
      },
    });
    const frames = (await response.text()).trim().split("\n\n").map((frame) => frame.slice(6));
    const call = JSON.parse(frames[1]).choices[0].delta.tool_calls[0];
    assert.equal(call.index, 0);
    assert.equal(call.function.name, "add_todo");
    assert.equal(JSON.parse(call.function.arguments).title, "买牛奶");
    assert.equal(frames[3], "[DONE]");
  });

  await test("droid errors become redacted OpenAI errors", async () => {
    const response = await request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "STUB:ERROR" }] },
    });
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.ok(!text.includes("fk-FAKEKEY_123"));
    assert.match(text, /\[已隐藏\]/);
    assert.equal(JSON.parse(text).error.type, "invalid_request_error");
  });

  await test("non-zero and invalid droid output return 502", async () => {
    for (const marker of ["EXIT", "INVALID"]) {
      const response = await request(relay, "/v1/chat/completions", {
        method: "POST",
        body: { messages: [{ role: "user", content: `STUB:${marker}` }] },
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.type, "invalid_request_error");
    }
  });

  await test("multi-byte characters split across stdout chunks are decoded intact", async () => {
    const response = await request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "STUB:UTF8-SPLIT" }] },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "汉字跨块");
  });

  await test("malformed unauthenticated request targets cannot crash the relay", async () => {
    for (const target of ["//a:99999/", "//[/", "http://[/"]) {
      assert.match(await rawRequestLine(relay, target), /^HTTP\/1\.1 404 /);
    }
    assert.equal(relay.child.exitCode, null);
    const health = await request(relay, "/healthz", { auth: null });
    assert.equal(health.status, 200);
  });
});

await test("SIGTERM shuts down cleanly and removes the droid sandbox", async () => {
  const relay = await startRelay();
  const response = await request(relay, "/v1/chat/completions", {
    method: "POST",
    body: { messages: [{ role: "user", content: "STUB:CAPTURE" }] },
  });
  const captured = JSON.parse((await response.json()).choices[0].message.content);
  const sandboxDir = captured.args[captured.args.indexOf("--cwd") + 1];
  await fs.access(sandboxDir);
  const exitCode = await new Promise((resolve) => {
    relay.child.once("exit", (code) => resolve(code));
    relay.child.kill("SIGTERM");
  });
  assert.equal(exitCode, 0);
  await assert.rejects(fs.access(sandboxDir));
});

await withRelay({ TIMEOUT_MS: "60" }, async (relay) => {
  await test("timed-out droid is killed and returns 504", async () => {
    const response = await request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "STUB:TIMEOUT" }] },
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.type, "invalid_request_error");
  });
});

await withRelay({ MAX_CONCURRENCY: "1", TIMEOUT_MS: "3000" }, async (relay) => {
  await test("concurrency overflow returns 429", async () => {
    const first = request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "STUB:SLOW" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "STUB:PLAIN" }] },
    });
    assert.equal(second.status, 429);
    assert.equal((await first).status, 200);
  });
});

await withRelay({ MAX_REQUESTS_PER_MINUTE: "2" }, async (relay) => {
  await test("sequential requests are capped per minute, not just per moment", async () => {
    const send = () => request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "STUB:PLAIN" }] },
    });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const third = await send();
    assert.equal(third.status, 429);
    assert.match((await third.json()).error.message, /per minute/);
  });
});

await withRelay({ MAX_BODY_BYTES: "40" }, async (relay) => {
  await test("oversized request bodies return 413", async () => {
    const response = await request(relay, "/v1/chat/completions", {
      method: "POST",
      body: { messages: [{ role: "user", content: "x".repeat(100) }] },
    });
    assert.equal(response.status, 413);
  });
});

if (failures.length) {
  process.stderr.write(`\n${failures.length} relay test(s) failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\nAll relay tests passed.\n");
}
