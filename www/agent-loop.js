/**
 * Agent 多轮控制（纯逻辑，可 Node 单测）。
 * complete 首轮 → 本地跑工具 → stream(auto) 可继续要工具 → 直到无 tool_calls 或达上限。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LUMINA_AGENT_LOOP = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_MAX_ROUNDS = 6;
  const TOOL_RESULT_MAX = 6000;
  const LIMIT_REACHED_TEXT =
    "已达 Agent 轮数上限，部分操作可能尚未完成。请再发一条继续。";

  /**
   * 工具结果进入下一轮上下文前必须保持为完整 JSON。直接从字符串中间截断会让
   * 模型收到残缺对象，尤其 list_todos 返回长标题时会误判操作结果。
   */
  function serializeToolResult(result) {
    const normalized =
      result === undefined
        ? { ok: false, error: "工具未返回结果", code: "EMPTY_TOOL_RESULT" }
        : result;
    try {
      const content = JSON.stringify(normalized);
      if (typeof content !== "string") throw new TypeError("工具结果不是可序列化值");
      if (content.length <= TOOL_RESULT_MAX) return content;

      const compact = {
        ok: normalized?.ok === true,
        truncated: true,
        code: "TOOL_RESULT_TRUNCATED",
        message: "工具结果过长，已省略详细条目；请用更精确的筛选条件重新查询。",
      };
      if (typeof normalized?.count === "number") compact.count = normalized.count;
      if (typeof normalized?.message === "string") compact.summary = normalized.message.slice(0, 512);
      return JSON.stringify(compact);
    } catch {
      return JSON.stringify({
        ok: false,
        error: "工具结果无法序列化",
        code: "TOOL_RESULT_SERIALIZE",
      });
    }
  }

  /**
   * @param {object} opts
   * @param {object[]} opts.messages 可变；messages[0] 应为 system
   * @param {number} [opts.maxRounds=6]
   * @param {() => boolean} [opts.isAborted]
   * @param {(messages: object[], round: number) => Promise<{
   *   ok: boolean, aborted?: boolean, error?: string,
   *   message?: { content?: string, tool_calls?: object[] }
   * }>} opts.complete
   * @param {(messages: object[]) => Promise<{
   *   text?: string, toolCalls?: object[], aborted?: boolean
   * }>} opts.streamRound
   * @param {(tc: object) => unknown|Promise<unknown>} opts.runTool
   * @param {() => string} opts.refreshSystemContent
   * @param {(info: { phase: string, round?: number, content?: string }) => void} [opts.onProgress]
   * @returns {Promise<{
   *   finalText: string, aborted: boolean, limitReached: boolean,
   *   rounds: number, afterTools: boolean
   * }>}
   */
  async function runAgentRounds(opts) {
    const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const messages = opts.messages;
    const isAborted = opts.isAborted || (() => false);
    const complete = opts.complete;
    const streamRound = opts.streamRound;
    const runTool = opts.runTool;
    const refreshSystemContent = opts.refreshSystemContent;
    const onProgress = opts.onProgress || (() => {});

    let finalText = "";
    /** 跑过工具后改走 stream(auto)，可继续要工具（E1） */
    let afterTools = false;
    let roundsUsed = 0;
    /** 上游流返回 aborted（超时/用户停）时为 true；与本地 isAborted 合并 */
    let upstreamAborted = false;
    /** 因轮数用尽退出且尚无最终回复 */
    let limitReached = false;

    function validateToolCalls(toolCalls) {
      const seen = new Set();
      for (const tc of toolCalls) {
        const id = typeof tc?.id === "string" ? tc.id.trim() : "";
        const name = tc?.function?.name || tc?.name || "";
        if (!id || !name || seen.has(id)) {
          const err = new Error("模型返回了无效或重复的工具调用，未执行任何操作");
          err.code = "INVALID_TOOL_CALLS";
          throw err;
        }
        seen.add(id);
      }
      return toolCalls;
    }

    async function pushToolResults(toolCalls) {
      for (const tc of toolCalls) {
        if (isAborted()) break;
        let result;
        try {
          // 支持 async 工具（如 ClickUp 上传）；同步工具仍用 Promise.resolve 包一层
          result = await Promise.resolve(runTool(tc));
        } catch (err) {
          // P2：单工具 throw 不得炸掉整轮；序列化失败结果给模型收尾
          result = {
            ok: false,
            error: err?.message || String(err) || "工具执行失败",
            code: "TOOL_THROW",
          };
        }
        const content = serializeToolResult(result);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content,
        });
      }
      // 仅在内容真变时改写 system，避免无意义替换打断前缀引用稳定性
      const nextSys = refreshSystemContent();
      if (!messages[0] || messages[0].role !== "system" || messages[0].content !== nextSys) {
        messages[0] = { role: "system", content: nextSys };
      }
    }

    for (let round = 0; round < maxRounds; round++) {
      if (isAborted()) break;
      roundsUsed = round + 1;
      onProgress({ phase: "think", round });

      // 已执行过工具 → 流式一轮（tool_choice:auto），仍可再要工具
      if (afterTools) {
        onProgress({ phase: "stream", round });
        const streamed = await streamRound(messages);

        // P0：上游 aborted 是硬闸门——保留部分文本，绝不执行该流里的 tool_calls
        // （可能残缺 / 非预期，主进程超时也会带 aborted + 已累计片段）
        if (streamed.aborted) {
          upstreamAborted = true;
          finalText = (streamed.text || "").trim() || "（已停止）";
          break;
        }
        const toolCalls = validateToolCalls(
          Array.isArray(streamed.toolCalls) ? streamed.toolCalls : []
        );

        if (toolCalls.length && !isAborted()) {
          messages.push({
            role: "assistant",
            content: streamed.text || "",
            tool_calls: toolCalls,
          });
          onProgress({ phase: "tools", round, content: streamed.text || "" });
          await pushToolResults(toolCalls);
          continue;
        }

        finalText = (streamed.text || "").trim() || "（已完成操作）";
        if (isAborted() && !finalText) finalText = "（已停止）";
        break;
      }

      // 首段：complete(tools) — 无工具则直接收 content，避免多打一枪
      const res = await complete(messages, round);
      if (isAborted()) break;

      if (!res?.ok) {
        if (res?.aborted) {
          upstreamAborted = true;
          finalText = "（已停止）";
          break;
        }
        throw new Error(res?.error || "请求失败");
      }

      const msg = res.message || {};
      const toolCalls = validateToolCalls(
      Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    );
      const content = (msg.content || "").trim();

      if (toolCalls.length) {
        messages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: toolCalls,
        });
        onProgress({ phase: "tools", round, content });
        await pushToolResults(toolCalls);
        afterTools = true;
        continue;
      }

      finalText = content || "（已完成操作）";
      break;
    }

    const aborted = isAborted() || upstreamAborted;

    // P1：轮数用尽且仍停在「刚跑完工具、没有最终回复」→ 禁止谎报「操作已执行」
    if (!finalText && !aborted) {
      if (afterTools && roundsUsed >= maxRounds) {
        limitReached = true;
        finalText = LIMIT_REACHED_TEXT;
      } else {
        finalText = "操作已执行。还需要我做什么吗？";
      }
    }
    if (aborted && !finalText) finalText = "（已停止）";

    return {
      finalText,
      aborted,
      limitReached,
      rounds: roundsUsed,
      afterTools,
    };
  }

  return {
    runAgentRounds,
    DEFAULT_MAX_ROUNDS,
    TOOL_RESULT_MAX,
    LIMIT_REACHED_TEXT,
    serializeToolResult,
  };
});
