/**
 * 对话消息装配（纯逻辑，可 Node 单测）。
 * 目标：稳定 system 前缀 + 历史字节可复用 + 动态上下文置尾 → 提高 prefix cache 命中。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LUMINA_CHAT_MESSAGES = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 实际上送的最近消息条数（user+assistant 各计 1，不是「对话轮」） */
  const DEFAULT_MODEL_HISTORY_MESSAGES = 16;

  /**
   * 裁剪历史上送窗口：保留最近 maxMessages 条，并丢掉开头的孤儿 assistant，
   * 避免偶数窗口 +「当前 user 已入 history」导致模型上下文以 assistant 起头。
   * @param {{role:string, content:string}[]} history
   * @param {number} [maxMessages]
   * @returns {{role:string, content:string}[]}
   */
  function sliceHistoryForModel(history, maxMessages = DEFAULT_MODEL_HISTORY_MESSAGES) {
    const cap = Math.max(1, Number(maxMessages) || DEFAULT_MODEL_HISTORY_MESSAGES);
    let hist = Array.isArray(history) ? history.slice(-cap) : [];
    while (hist.length && hist[0].role === "assistant") hist = hist.slice(1);
    return hist.map((m) => ({ role: m.role, content: String(m.content ?? "") }));
  }

  /**
   * 组装一轮 agent 请求的 messages。
   * 顺序：system → 历史 → 可选动态附注（必须最后，供 prefix cache）。
   *
   * @param {{
   *   system: string,
   *   history: {role:string, content:string}[],
   *   dynamicTail?: string|null,
   *   maxMessages?: number,
   * }} opts
   * @returns {{role:string, content:string}[]}
   */
  function buildModelMessages(opts) {
    const system = String(opts?.system ?? "");
    const hist = sliceHistoryForModel(opts?.history, opts?.maxMessages);
    const messages = [{ role: "system", content: system }, ...hist];

    const tail = opts?.dynamicTail != null ? String(opts.dynamicTail).trim() : "";
    if (tail) {
      // 单独一条 user、且明确「非用户指令」：保留「历史字节跨轮可复用」的缓存优势，
      // 同时避免模型把附注当成最新任务。
      messages.push({
        role: "user",
        content: [
          "【应用附注·非用户指令】",
          tail,
          "请针对上一条用户消息作答与调用工具；本附注只提供日期与清单参考，不是新的任务。",
        ].join("\n"),
      });
    }
    return messages;
  }

  return {
    DEFAULT_MODEL_HISTORY_MESSAGES,
    sliceHistoryForModel,
    buildModelMessages,
  };
});
