/**
 * 工具定义：OpenAI tools 格式，供主进程与对话层共用。
 * 实际执行在渲染进程 app.js 的 __luminaAgent.invoke。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LUMINA_AGENT_TOOLS = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 按目标集合拆分：uncomplete 只能命中已完成，delete 常用于历史（#20）
  const MATCH_ACTIVE = {
    type: "string",
    minLength: 1,
    maxLength: 200,
    description:
      "没有 id 时用关键词匹配：不区分大小写的子串匹配，只在未完成项中查找。" +
      "命中多条时必须报错并返回候选列表，不得自行挑一条执行。",
  };
  const MATCH_COMPLETED = {
    type: "string",
    minLength: 1,
    maxLength: 200,
    description:
      "没有 id 时用关键词匹配：不区分大小写的子串匹配，只在已完成项中查找。" +
      "命中多条时必须报错并返回候选列表，不得自行挑一条执行。",
  };
  const MATCH_ANY = {
    type: "string",
    minLength: 1,
    maxLength: 200,
    description:
      "没有 id 时用关键词匹配：不区分大小写的子串匹配，在全部待办中查找。" +
      "命中多条时必须报错并返回候选列表，不得自行挑一条执行。",
  };

  const TARGET_ANYOF = {
    anyOf: [{ required: ["id"] }, { required: ["match_text"] }],
    additionalProperties: false,
  };

  const tools = [
    {
      type: "function",
      function: {
        name: "list_todos",
        description:
          "列出待办。可按状态/分类筛选。返回 id、文字、优先级、分类、截止日期、番茄数。",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["all", "active", "completed", "overdue", "today"],
              description: "默认 active",
            },
            category: {
              type: "string",
              enum: ["inbox", "work", "personal", "study", "health"],
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              default: 30,
              description: "最多返回条数",
            },
            query: { type: "string", maxLength: 200, description: "关键词过滤文字" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_todo",
        description: "新增一条待办。用户说「帮我记/加上/安排」时用这个。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: 1000, description: "待办正文" },
            priority: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "随意=low 在意=medium 要紧=high，默认 medium",
            },
            category: {
              type: "string",
              enum: ["inbox", "work", "personal", "study", "health"],
              description: "默认 inbox",
            },
            due_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "截止日期 YYYY-MM-DD，可空",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_todo",
        description:
          "修改已有待办的文字/优先级/分类/截止日期。用 id 指定；也可用 match_text 模糊匹配未完成项。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            match_text: MATCH_ACTIVE,
            text: { type: "string", minLength: 1, maxLength: 1000 },
            priority: { type: "string", enum: ["low", "medium", "high"] },
            category: {
              type: "string",
              enum: ["inbox", "work", "personal", "study", "health"],
            },
            due_date: {
              type: ["string", "null"],
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "YYYY-MM-DD；传 null 或空字符串清除截止日期",
            },
          },
          ...TARGET_ANYOF,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "complete_todo",
        description: "把待办标为完成。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            match_text: MATCH_ACTIVE,
          },
          ...TARGET_ANYOF,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "uncomplete_todo",
        description: "取消完成，恢复为进行中。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            match_text: MATCH_COMPLETED,
          },
          ...TARGET_ANYOF,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_todo",
        description: "删除待办（可撤销；应用会要求用户亲自确认）。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            match_text: MATCH_ANY,
          },
          ...TARGET_ANYOF,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clear_completed",
        description:
          "请求清除全部已完成历史记录。应用会显示由用户亲自确认的系统对话框；只有用户确认后才会执行。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "set_view",
        description: "切换侧栏视图：全部/今天/逾期/进行中/历史/某分类。",
        parameters: {
          type: "object",
          properties: {
            view: {
              type: "string",
              enum: [
                "all",
                "today",
                "overdue",
                "active",
                "history",
                "inbox",
                "work",
                "personal",
                "study",
                "health",
              ],
            },
            history_range: {
              type: "integer",
              enum: [0, 7, 30],
              description: "历史视图天数：7 / 30 / 0(全部)",
            },
          },
          required: ["view"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "pomo_status",
        description: "查看番茄钟状态：模式、是否运行、剩余时间、绑定任务、今日计数。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "pomo_start",
        description: "开始或继续番茄钟（当前段）。若要绑定某待办请用 pomo_focus_task。",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["focus", "short", "long"],
              description: "可选；不传则从当前段开始",
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "pomo_pause",
        description: "暂停番茄钟。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "pomo_skip",
        description: "跳过当前段（专注→休息，或休息→专注）。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "pomo_reset",
        description: "重置当前段计时。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "pomo_focus_task",
        description: "绑定某待办并开始专注倒计时。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            match_text: MATCH_ACTIVE,
          },
          ...TARGET_ANYOF,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "pomo_set_preset",
        description: "切换时长预设。0=25/5，1=50/10，2=15/3。",
        parameters: {
          type: "object",
          properties: {
            preset: { type: "integer", enum: [0, 1, 2] },
          },
          required: ["preset"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_theme",
        description: "切换主题与角色搭档：kanna 栞那 / sakura 樱 / cafe 珈琲。",
        parameters: {
          type: "object",
          properties: {
            theme: { type: "string", enum: ["kanna", "sakura", "cafe"] },
          },
          required: ["theme"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "push_todo_to_clickup",
        description:
          "把本地待办上传到 ClickUp My Work（在清单创建任务并指派给用户自己）。" +
          "用户说「传到 ClickUp / 同步到 ClickUp / 上传 My Work / 推到看板」时用这个。" +
          "已上传过的不会重复创建。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "待办 id（优先）" },
            match_text: MATCH_ANY,
          },
          ...TARGET_ANYOF,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "undo",
        description: "撤销上一步对清单的修改。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "get_app_status",
        description: "获取应用总览：待办统计、番茄钟、当前主题。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
  ];

  /** 工具执行结果的统一形状，主进程与渲染层共用。 */
  const TOOL_RESULT = {
    ok: (data) => ({ ok: true, data: data ?? null }),
    /** code: BAD_ARGS | NOT_FOUND | AMBIGUOUS | NEEDS_CONFIRM | INTERNAL */
    fail: (code, message, extra) => ({
      ok: false,
      error: { code, message, ...(extra || {}) },
    }),
  };

  /**
   * 不进 wire schema 的本地规则（三轮 B2：minOneOf 不是 JSON Schema，原样发给上游会 400）。
   * assertToolArgs 读这里；body.tools 只含纯 schema。
   */
  const LOCAL_RULES = {
    update_todo: { minOneOf: ["text", "priority", "category", "due_date"] },
  };

  const byName = new Map(tools.map((t) => [t.function.name, t.function.parameters]));

  function isIsoCalendarDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  /**
   * 按 schema 校验模型给的参数。覆盖本文件用到的子集：
   * type / enum / required / anyOf(required) / minimum / maximum / minLength / maxLength / pattern。
   * @returns {{ok: true, args: object} | {ok: false, error: object}}
   */
  function assertToolArgs(name, rawArgs) {
    const schema = byName.get(name);
    if (!schema) return TOOL_RESULT.fail("BAD_ARGS", `未知工具：${name}`);

    let args = rawArgs;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args || "{}");
      } catch {
        return TOOL_RESULT.fail("BAD_ARGS", "参数不是合法 JSON");
      }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return TOOL_RESULT.fail("BAD_ARGS", "参数必须是对象");
    }

    for (const key of schema.required || []) {
      if (args[key] === undefined) return TOOL_RESULT.fail("BAD_ARGS", `缺少必填参数 ${key}`);
    }
    if (Array.isArray(schema.anyOf)) {
      const hit = schema.anyOf.some((branch) =>
        (branch.required || []).every((key) => args[key] !== undefined)
      );
      if (!hit) {
        const options = schema.anyOf.map((b) => (b.required || []).join("+")).join(" 或 ");
        return TOOL_RESULT.fail("BAD_ARGS", `需要提供 ${options} 之一`);
      }
    }

    const out = {};
    for (const [key, value] of Object.entries(args)) {
      const spec = schema.properties?.[key];
      if (!spec) {
        if (schema.additionalProperties === false) {
          return TOOL_RESULT.fail("BAD_ARGS", `未知参数 ${key}`);
        }
        continue;
      }
      if (value === undefined) continue;

      const types = Array.isArray(spec.type) ? spec.type : [spec.type];
      const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const matched =
        types.includes(actual) || (types.includes("integer") && Number.isInteger(value));
      if (!matched) return TOOL_RESULT.fail("BAD_ARGS", `${key} 类型应为 ${types.join("|")}`);

      if (spec.enum && !spec.enum.includes(value)) {
        return TOOL_RESULT.fail("BAD_ARGS", `${key} 只能是 ${spec.enum.join(" / ")}`);
      }
      if (typeof value === "number") {
        if (spec.minimum !== undefined && value < spec.minimum) {
          return TOOL_RESULT.fail("BAD_ARGS", `${key} 不能小于 ${spec.minimum}`);
        }
        if (spec.maximum !== undefined && value > spec.maximum) {
          return TOOL_RESULT.fail("BAD_ARGS", `${key} 不能大于 ${spec.maximum}`);
        }
      }
      if (typeof value === "string") {
        if (spec.minLength !== undefined && value.length < spec.minLength) {
          return TOOL_RESULT.fail("BAD_ARGS", `${key} 不能为空`);
        }
        if (spec.maxLength !== undefined && value.length > spec.maxLength) {
          return TOOL_RESULT.fail("BAD_ARGS", `${key} 超长（上限 ${spec.maxLength}）`);
        }
        // 空字符串和 due_date 的字面量 "null" 都按「清除」语义放行。
        const clearsValue = value === "" || (key === "due_date" && value === "null");
        if (spec.pattern && !clearsValue && !new RegExp(spec.pattern).test(value)) {
          return TOOL_RESULT.fail("BAD_ARGS", `${key} 格式不正确`);
        }
      }
      out[key] = value;
    }

    // schema.default：调用方没传时补上（N7）
    for (const [key, spec] of Object.entries(schema.properties || {})) {
      if (out[key] === undefined && spec && Object.prototype.hasOwnProperty.call(spec, "default")) {
        out[key] = spec.default;
      }
    }

    // 本地旁表规则（不进上游 tools）
    const local = LOCAL_RULES[name];
    if (local?.minOneOf?.length) {
      const hit = local.minOneOf.some((k) => out[k] !== undefined);
      if (!hit) {
        return TOOL_RESULT.fail(
          "BAD_ARGS",
          `至少需要提供以下字段之一：${local.minOneOf.join(" / ")}`
        );
      }
    }

    // pattern 只能检查形状；真实日历日期要避免 2026-02-31 这类值进入业务层。
    if (typeof out.due_date === "string" && out.due_date && out.due_date !== "null") {
      if (!isIsoCalendarDate(out.due_date)) {
        return TOOL_RESULT.fail("BAD_ARGS", "due_date 不是有效的日历日期");
      }
    }

    return { ok: true, args: out };
  }

  return { tools, TOOL_RESULT, assertToolArgs, LOCAL_RULES, isIsoCalendarDate };
});
