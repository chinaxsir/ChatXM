# API 调用指南

> 适用：`https://gate.127110.xyz`（OpenAI 兼容网关）
> 更新：2026-11-09 ｜ 网关版本 `82aceb42`

---

## 一、这次有哪些变化

| 变更 | 影响 |
|--|--|
| 模型列表排序调整 | `/v1/models` 现在**文本模型在前、生图模型在后**；第三方 Agent 取首个模型不会再拿到画图模型 |
| 池名智能选型 | 传 `gemini` / `glm` 池名时，网关按意图在池内挑选模型（画图→生图模型，带图→视觉模型，复杂任务→旗舰，普通问答→轻量） |
| 生图模型加了意图门槛 | 选生图模型做普通对话时，**自动降级为同厂商文本模型**，不会再"所有回答都变成图片"；只有提示词含「画/绘制/生成图片/draw/generate image」才真出图 |
| 跨厂商兜底 | 所选厂商全部失败（503/超时/额度耗尽）时，自动切到另一厂商等价模型，不再整体不可用 |
| 快速熔断 | 同厂商网络超时 1 次、或限流/5xx 累计 2 次即换厂商；单次尝试限时 16/8 秒（流式）、24/14 秒（非流式） |
| 全局超时缩短 | 90 秒 → 65 秒，保证在常见客户端 60 秒窗口内返回结构化错误 |
| 每日配额响应头 | 所有成功响应都带 `X-Daily-*`，可直接做进度条 |
| 计费拆分 | 输入、输出分别计价，输出约为输入的 5 倍；图片按张计费 |

接口路径与鉴权方式**未变**，老代码可直接继续用。

---

## 二、基础信息

| 项目 | 值 |
|--|--|
| Base URL | `https://gate.127110.xyz/v1` |
| 鉴权 | `Authorization: Bearer sk-xxxx`（密钥在控制台「API 密钥」创建） |
| 协议 | OpenAI Chat Completions 兼容 |
| 流式 | `stream: true` → `text/event-stream` |
| 建议客户端超时 | 非流式 ≥ 60 秒；流式首字节 ≥ 30 秒 |
| 并发 | 同一密钥建议 ≤ 3 并发；总量受每日配额限制 |

密钥与**账号计划（basic/pro/biz）**、**面板上的 API 调优 / 专属预设**、IP 白名单绑定，改密钥不影响已发请求。

---

## 三、支持的端点

| 方法 | 路径 | 说明 |
|--|--|--|
| POST | `/v1/chat/completions` | 对话（文本 / 视觉 / 工具调用 / 生图意图） |
| POST | `/v1/completions` | 旧版文本补全（兼容） |
| POST | `/v1/images/generations` | 文生图 |
| GET | `/v1/models` | 模型列表（含扩展字段 `model_pools`；此端点无需鉴权） |
| GET | `/health` | 健康检查 |
| GET | `/api/client-portal/usage` | 今日用量（需 `x-session-token`，非 API Key） |

**不支持**（返回 400 `endpoint_unsupported`）：`/v1/images/edits`、`/v1/images/variations`、`/v1/audio/*`。

---

## 四、快速开始

### 1) curl

```bash
curl https://gate.127110.xyz/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini",
    "messages": [{"role": "user", "content": "用一句话介绍杭州"}],
    "stream": false
  }'
```

> Windows PowerShell 下请把 JSON 放进文件再用 `-d @body.json`，避免引号被转义导致 `model` 解析失败。

### 2) OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(api_key="sk-xxxxxxxx", base_url="https://gate.127110.xyz/v1")

resp = client.chat.completions.create(
    model="gemini",                      # 也可写池名 glm，或具体模型
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

### 3) 原生 fetch（浏览器 / Node 18+）

```js
const res = await fetch("https://gate.127110.xyz/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer sk-xxxxxxxx",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "glm-4-flash",
    messages: [{ role: "user", content: "你好" }],
    stream: true,
  }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    const delta = JSON.parse(data).choices?.[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
  }
}
```

---

## 五、模型选择

### 池（推荐给第三方 Agent）

| 值 | 含义 |
|--|--|
| `gemini` | Gemini 智能池（自动选型） |
| `glm` | GLM 智能池（自动选型） |

池内选型规则：

- 普通问答 → 轻量模型（省成本）
- 长文本 / 代码 / 推理 → 旗舰模型
- 带图片输入 → 视觉模型
- 提示词含画图意图 → 生图模型
- 主厂商失败 → 自动切到另一池的等价模型

### 具体模型（精确锁定，共 31 个）

`/v1/models` 共返回 33 条 = 31 个具体模型 + 2 个池名（`gemini`、`glm`）。

**Gemini 池（15）**

- 文本：`gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.5-flash-lite`、`gemini-3.1-flash-lite`
- 通用：`kilo-auto/free`
- 生图：`gemini-3-pro-image`、`gemini-3-pro-image-preview`、`gemini-3.1-flash-image`、`gemini-3.1-flash-image-preview`、`gemini-3.1-flash-lite-image`、`gemini-2.5-flash-image`
- 另含通用生图：`cogview-3-flash`、`cogview-4`（智谱生图，已纳入 Gemini 池候选）

**GLM 池（16）**

- 文本：`glm-5.3`、`glm-5.3-flash`、`glm-5.3-flashx`、`glm-5.2`、`glm-5.1`、`glm-5`、`glm-5-turbo`、`glm-4.7`、`glm-4.7-flash`、`glm-4.6`、`glm-4.6v-flash`（视觉）、`glm-4.5`、`glm-4.5-air`、`glm-4-flash`、`glm-z1-flash`
- 通用：`kilo-auto/free`（与 Gemini 池共用）

> `glm-4.5-flash` 只在 `/v1/models` 中可单独指定，未进入 GLM 池自动选型。

> 想用某个模型的所有能力差异（如强制视觉、强制旗舰），请直接用具体模型名；想省心就用池名。
> 响应体里的 `model` 字段会**回显你请求时的名字**（池名或具体模型），实际执行的模型以控制台计费记录为准。

---

## 六、对话参数

```json
{
  "model": "gemini",
  "messages": [
    { "role": "system", "content": "你是一个简洁的助手" },
    { "role": "user", "content": "介绍一下杭州" }
  ],
  "temperature": 0.7,
  "max_tokens": 2048,
  "top_p": 1,
  "stream": true
}
```

- `messages`：支持 `system` / `user` / `assistant`；`tools`、`tool_choice`、`response_format` 等字段**原样透传**给上游
- `temperature` / `top_p` / `max_tokens`：透传；若该密钥在面板开启了「API 调优」，服务端会按调优覆盖 temperature（coding=0.2、creative=0.85）
- 未传 `model`：网关用默认池自动选型，不再报错
- 未知模型名：直接透传尝试，失败后返回明确错误

### 视觉输入

```json
{
  "model": "glm",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "这张图里有什么？" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxxx" } }
    ]
  }]
}
```

`url` 支持公网图片地址或 base64 data URL。带图请求会自动路由到视觉模型。

---

## 七、生图

### 方式 A：标准文生图端点

```bash
curl https://gate.127110.xyz/v1/images/generations \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"cogview-3-flash","prompt":"一只在星空下奔跑的猫","n":1,"size":"1024x1024"}'
```

返回 OpenAI 标准结构：`{"created":..., "data":[{"url":"https://..."}]}`。

### 方式 B：对话里出图（适合只能用 chat 端点的客户端）

选择任一生图模型，并在提示词中包含「画 / 绘制 / 生成图片 / draw / generate image」等意图词：

```json
{ "model": "cogview-4", "messages": [{ "role": "user", "content": "画一只在月亮上的兔子" }] }
```

返回值仍是标准 `chat.completion`，`content` 为图片 Markdown：`![image](https://...)`。流式同样可用。

> 生图模型 + 无画图意图 = 自动改用同厂商文本模型（返回文本），不会浪费一次画图费用。

---

## 八、每日配额（三档，与 Gemini 口径一致）

| 计划 | 每日请求上限 | 重置时间 |
|--|--|--|
| Basic | 50 次 | 太平洋时间午夜 |
| Pro | 300 次 | 太平洋时间午夜 |
| Biz | 1500 次 | 太平洋时间午夜 |

- 计数单位是**请求次数**（RPD），按账号累计，与密钥数量无关
- **请求发出即计 1 次**，上游失败也不退回（与 Gemini 口径一致）
- 生图请求同样计入 1 次

### 用量响应头

每个成功响应都带（已加入 CORS `Expose-Headers`）：

| 头 | 含义 |
|--|--|
| `X-Daily-Limit` | 今日上限（如 300） |
| `X-Daily-Remaining` | 剩余次数 |
| `X-Daily-Reset` | 重置时刻（Unix 秒） |

触顶返回：

```json
{
  "error": {
    "message": "今日配额已用完（PRO 版每日 300 次），配额将于太平洋时间午夜重置。",
    "type": "daily_quota_exceeded",
    "code": 429,
    "daily_quota": { "used": 300, "limit": 300, "remaining": 0, "resets_at": 1790000000, "plan_type": "pro" }
  }
}
```

HTTP 状态 `429`，同时带 `X-Daily-Reset`。客户端应读取 `daily_quota.resets_at` 做倒计时。

若不想每次从响应头取，也可调用 `GET /api/client-portal/usage`（需用户会话 `x-session-token`，不是 API Key），返回 `daily: { date, used, limit, remaining, resets_at, reset_seconds }`。

---

## 九、计费

按**实际消耗**从账户余额扣减，单位为美元。

### 文本：按 1K tokens 计

| 档位 | 适用模型 | 输入 / 1K | 输出 / 1K |
|--|--|--|--|
| 轻量 | `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`、`glm-4-flash`、`glm-4.5-flash`、`glm-4.6v-flash`、`glm-4.7-flash`、`glm-5.3-flash(x)`、`glm-z1-flash`、`kilo-auto/free` | $0.0002 | $0.001 |
| 标准 | `gemini-3.5/3.6/3.7/3.8-flash`、`glm-4.5`、`glm-4.5-air`、`glm-4.6`、`glm-4.7`、`glm-5`、`glm-5-turbo`、`glm-5.1`、`glm-5.2`、`glm-5.3` | $0.0004 | $0.002 |

### 图片：按张计

| 模型 | 单价 / 张 |
|--|--|
| `cogview-3-flash` | $0.008 |
| `cogview-4` | $0.012 |
| `gemini-2.5-flash-image`、`gemini-3-pro-image(-preview)`、`gemini-3.1-flash-image(-preview)`、`gemini-3.1-flash-lite-image` | $0.045 |

未登记的新模型按标准档兜底计费。余额不足返回 `402 insufficient_balance`。

---

## 十、错误码

统一格式：`{"error": {"code": "...", "message": "..."}}`（配额错误额外含 `type` 与 `daily_quota`）。

| 状态 | code | 含义 / 处理 |
|--|--|--|
| 400 | `image_model_requires_intent` | 生图模型被用于普通对话且同池无可用文本模型；改用文本模型或加画图关键词 |
| 400 | `endpoint_unsupported` | 调用了不支持的端点（images/edits、audio 等） |
| 401 | `unauthorized` | 未带 / 带了错误的 API Key |
| 402 | `insufficient_balance` | 余额不足，需充值 |
| 403 | `token_frozen` / `ip_rejected` / `account_suspended` / `content_policy_violation` | 密钥冻结 / IP 不在白名单 / 账号停用 / 内容拦截 |
| 429 | `daily_quota_exceeded` | 今日配额用完，按 `resets_at` 等待 |
| 502 | `--` | 无法连接上游 |
| 503 | `no_channels` | 所有候选节点均不可用（已做跨厂商兜底后仍失败） |
| 504 | `--` | 上游响应超时（错误信息里会带「请求模型：xxx」） |

> 502/503/504 都是**可重试**错误；网关内部已经做过跨厂商故障转移，客户端重试 1 次即可，不必循环重试。

---

## 十一、面板「API 调优 / 专属预设」

在控制台密钥编辑处勾选后，**服务端自动生效**，客户端无需改代码：

| 调优 | 服务端行为 |
|--|--|
| `coding` | 注入开发规范 system prompt，temperature 强制 0.2，选型偏向旗舰模型 |
| `creative` | 注入发散提示，temperature 强制 0.85 |
| `concise` | 注入极简回复要求，选型偏向轻量模型 |
| `json` | 强制仅返回合法 JSON，选型偏向旗舰模型 |
| 专属预设 | 自定义内容注入 system prompt（**仅 Pro / Biz**） |

若你已在请求里自带 `system` 消息，预设内容会与之合并而不是覆盖。

---

## 十二、最佳实践

1. **第三方 Agent 默认写池名**（`gemini` 或 `glm`），由网关选型；需要固定效果时再写具体模型。
2. 长文本 / 多轮 / 代码任务**开启 `stream: true`**，避免非流式长等待触发客户端超时。
3. 客户端超时设为 60 秒，收到 502/503/504 只重试 1 次并退避 3–5 秒。
4. 用 `X-Daily-*` 头提前展示剩余次数，接近 0 时提示用户升级或等重置。
5. 不要把生图模型当默认对话模型；确需生图时在提示词里写清「画/生成图片」。
6. 生产环境建议给密钥配置 IP 白名单，并定期在控制台查看用量与计费记录。
