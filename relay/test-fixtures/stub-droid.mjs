#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const promptPath = args[args.indexOf("-f") + 1];
const prompt = fs.readFileSync(promptPath, "utf8");
const marker = prompt.match(/STUB:([A-Z-]+)/)?.[1] || "PLAIN";

if (marker === "TIMEOUT") {
  setTimeout(() => {}, 60000);
} else if (marker === "INVALID") {
  process.stdout.write("not-json\n");
} else {
  if (marker === "SLOW") await new Promise((resolve) => setTimeout(resolve, 400));
  const results = {
    PLAIN: "plain reply",
    STREAM: "streamed hello",
    "TOOL-VALID": '<tool_calls>[{"name":"add_todo","arguments":{"title":"买牛奶"}}]</tool_calls>',
    "TOOL-UNKNOWN": '<tool_calls>[{"name":"unknown_tool","arguments":{"title":"买牛奶"}}]</tool_calls>',
    "TOOL-MALFORMED": "<tool_calls>[not-json]</tool_calls>",
    "TOOL-NONE": '<tool_calls>[{"name":"add_todo","arguments":{"title":"买牛奶"}}]</tool_calls>',
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
