# api.donghl.com 接口用户手册

面向：其他开发 agent / 客户端开发

## 基础信息
- **Base URL**: `https://api.donghl.com`
- **认证方式**: `Authorization: Bearer <API_KEY>`
- **Content-Type**: `application/json`
- **CORS**: `Access-Control-Allow-Origin: *`

---

## 1) 健康检查
**GET** `/health`

**示例**
```bash
curl https://api.donghl.com/health
```

**示例响应**
```json
{
  "ok": true,
  "project": "ai-generator-openai-gateway",
  "version": "3.1.0",
  "capabilities": ["text","vision","image","video"],
  "request_id": "..."
}
```

---

## 2) 文本/对话生成（OpenAI Chat Completions 兼容）
**POST** `/v1/chat/completions`

**请求体**
```json
{
  "model": "qwen3.5",
  "messages": [
    {"role": "user", "content": "hello"}
  ]
}
```

**示例**
```bash
curl -X POST https://api.donghl.com/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5","messages":[{"role":"user","content":"hello"}]}'
```

**响应（节选）**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "qwen3.5",
  "choices": [
    {"index": 0, "message": {"role": "assistant", "content": "..."}}
  ]
}
```

> 说明：若使用流式返回，`Content-Type` 可能为 `text/event-stream`。

---

## 3) 图片生成
**POST** `/v1/images/generations`

**请求体**
```json
{
  "model": "z_image_turbo",
  "prompt": "a red apple on a table",
  "size": "1024x1024"
}
```

**示例**
```bash
curl -X POST https://api.donghl.com/v1/images/generations \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"z_image_turbo","prompt":"a red apple on a table","size":"1024x1024"}'
```

**响应说明**
图片任务为异步：
```json
{
  "created": 1773208552,
  "data": [],
  "task": {
    "id": "<task_id>",
    "status": "submitted",
    "poll_url": "/v1/tasks/<task_id>"
  }
}
```

需要通过 **任务查询接口** 获取最终图片 URL/base64。

---

## 4) 视频生成
**POST** `/v1/videos`

**请求体**（示例）
```json
{
  "model": "video",
  "prompt": "a cat playing piano",
  "size": "1024x576"
}
```

**示例**
```bash
curl -X POST https://api.donghl.com/v1/videos \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"video","prompt":"a cat playing piano","size":"1024x576"}'
```

**响应**
通常为异步任务，返回结构类似图片接口（含 `task.poll_url`）。

---

## 5) 任务查询（图片/视频异步结果）
**GET** `/v1/tasks/{task_id}`

**示例**
```bash
curl -X GET https://api.donghl.com/v1/tasks/<task_id> \
  -H "Authorization: Bearer <API_KEY>"
```

**可能响应字段**
- `status`: `submitted` | `running` | `success` | `failed`
- `result`: 成功时包含图片/视频 URL 或 base64
- `error`: 失败信息

---

## 常见问题
### 1. 返回 data 为空？
说明任务是异步的，请用 `task.poll_url` 轮询结果。

### 2. 403/401？
检查 `Authorization: Bearer <API_KEY>` 是否正确。

---

## 备注
- 如需新增模型或修改上游地址，请更新 Cloudflare Worker 配置并重新部署。
- 若你希望给开发者固定返回字段规范，请告知我补充。
