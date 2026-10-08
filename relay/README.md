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
# MAX_BODY_BYTES=1048576
```

启用服务后可通过 `/healthz` 检查状态。`Caddyfile.example` 展示了反向代理配置；App 请求需在 `Authorization` 中携带 `Bearer <RELAY_TOKEN>`。

本地运行测试：`node relay/test-relay.mjs`。
