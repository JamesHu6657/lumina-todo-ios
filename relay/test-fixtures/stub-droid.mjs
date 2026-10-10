#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const promptPath = args[args.indexOf("-f") + 1];
const prompt = fs.readFileSync(promptPath, "utf8");
const marker = prompt.match(/STUB:([A-Z0-9-]+)/)?.[1] || "PLAIN";

if (marker === "TIMEOUT") {
  setTimeout(() => {}, 60000);
} else if (marker === "INVALID") {
  process.stdout.write("not-json\n");
} else if (marker === "UTF8-SPLIT") {
  // 故意把一个三字节汉字拆在两次写入之间，模拟管道分块边界落在字符中间
  const line = Buffer.from(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "汉字跨块",
      usage: { inputTokens: 1, outputTokens: 1 },
    })}\n`,
    "utf8"
  );
  const cut = line.indexOf(Buffer.from("字", "utf8")) + 1;
  process.stdout.write(line.subarray(0, cut));
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.stdout.write(line.subarray(cut));
} else {
  if (marker === "SLOW") await new Promise((resolve) => setTimeout(resolve, 400));
  const results = {
    PLAIN: "plain reply",
    STREAM: "streamed hello",
    "TOOL-VALID": '<tool_calls>[{"name":"add_todo","arguments":{"title":"买牛奶"}}]</tool_calls>',
    "TOOL-UNKNOWN": '<tool_calls>[{"name":"unknown_tool","arguments":{"title":"买牛奶"}}]</tool_calls>',
    "TOOL-MALFORMED": "<tool_calls>[not-json]</tool_calls>",
    "TOOL-NONE": '<tool_calls>[{"name":"add_todo","arguments":{"title":"买牛奶"}}]</tool_calls>',
    "TOOL-PREFIX": '这是示例，不要执行：<tool_calls>[{"name":"add_todo","arguments":{"title":"示例"}}]</tool_calls>',
    "TOOL-SUFFIX": '<tool_calls>[{"name":"add_todo","arguments":{"title":"示例"}}]</tool_calls>这只是示例。',
    "TOOL-FENCED": '```xml\n<tool_calls>[{"name":"add_todo","arguments":{"title":"示例"}}]</tool_calls>\n```',
    "TOOL-MULTIPLE": '<tool_calls>[{"name":"add_todo","arguments":{"title":"示例"}}]</tool_calls>\n<tool_calls>[{"name":"add_todo","arguments":{"title":"示例"}}]</tool_calls>',
    "TOOL-WHITESPACE": ' \n<tool_calls>[{"name":"add_todo","arguments":{"title":"买牛奶"}}]</tool_calls>\n ',
    "TOOL-MIXED": '<tool_calls>[{"name":"add_todo","arguments":{"title":"买牛奶"}},{"name":"list_todos","arguments":{}}]</tool_calls>',
    "BRIDGE-TOOL": '<tool_calls>[{"name":"add_todo","arguments":{"text":"买牛奶","priority":"medium"}}]</tool_calls>',
    ERROR: "Factory returned fk-FAKEKEY_123",
  };
  const result = marker === "CAPTURE"
    ? JSON.stringify({
      args,
      prompt,
      promptMode: fs.statSync(promptPath).mode & 0o777,
      factoryKeyPresent: Boolean(process.env.FACTORY_API_KEY),
    })
    : results[marker] || results.PLAIN;
  const isError = marker === "ERROR";
  process.stdout.write("droid progress\n");
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: isError ? "error" : "success",
      is_error: isError,
      result,
      usage: { inputTokens: 7, outputTokens: 3 },
    })}\n`
  );
  if (marker === "EXIT") process.exitCode = 2;
}
