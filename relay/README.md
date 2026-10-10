# Factory droid 中转服务

本服务把 OpenAI 兼容的聊天请求转换为本机 `droid exec` 调用。要求 Node.js 20 及以上，并已安装可运行的 `droid` CLI。

创建非 root 的 `relay` 用户和可写 HOME `/var/lib/factory-relay`，把 Node 20+ 与 `droid` 安装到服务可访问的位置。复制 `factory-relay.service` 到 systemd 配置目录，并准备权限为 `600` 的 `/etc/factory-relay.env`：

```ini
FACTORY_API_KEY=你的Factory密钥
RELAY_TOKEN=至少24字符的中转口令
HOST=127.0.0.1
PORT=8787
DROID_BIN=/usr/local/bin/droid
DROID_MODEL=deepseek-v4.1-flash
# ALLOWED_MODELS=deepseek-v4.1-flash
# DROID_REASONING=high
# MAX_CONCURRENCY=2
# MAX_REQUESTS_PER_MINUTE=30   # 每分钟最多启动的 droid 次数，0 表示不限
# TIMEOUT_MS=90000             # App 端为 Factory 留了 105s，调大这里时别超过它
# BODY_TIMEOUT_MS=10000        # 接收完整请求体的上限；超时返回 408 并释放并发槽
# MAX_BODY_BYTES=1048576
```

启用服务后可通过 `/healthz` 检查状态。`Caddyfile.example` 展示了反向代理配置；App 请求需在 `Authorization` 中携带 `Bearer <RELAY_TOKEN>`。

本地运行测试：`node relay/test-relay.mjs`。

## 提示词缓存

中转把固定规则和工具定义放在前面，保留原始对话顺序，把本轮 `tool_choice` 放在尾部。工具按名称排序，JSON 对象键递归排序，数组顺序保持不变；等价的工具定义不会仅因对象键或工具列表顺序变化而打断共享前缀。App 的日期、待办摘要等动态上下文应继续放在对话尾部。

这是上游提示词缓存优化，不是回答缓存，也不复用不同请求的 droid 会话。实际命中取决于 Factory、模型、前缀长度及缓存有效期；仅凭前缀相同或响应变快不能判定命中。需用上游提供的缓存读取 token/用量指标对比连续请求，未提供该指标时不报告命中率。当前 OpenAI 兼容响应只映射输入和输出 token，不提供缓存命中统计。

## 工具调用与取消

只有整条模型回复仅包含一个 `<tool_calls>` 块（允许首尾空白）时才转换为工具调用；普通文字或代码围栏里的示例不会执行。指定 `tool_choice.function.name` 时，所有调用都必须匹配该名称，否则保留为普通文本；`none` 禁止调用工具。工具参数仍由 App 在执行前校验。

iOS 的非流式请求有独立的本地停止和超时机制，不依赖 CapacitorHttp 响应 `AbortSignal`。停止后会忽略迟到回复；原生网络请求本身不保证立即取消，因此服务器可能仍运行到自身超时。App 修复需重新构建并安装 IPA，仅部署 VPS 脚本不会更新手机端代码。
