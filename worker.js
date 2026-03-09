// =================================================================================
//  项目: ai-generator-2api (Cloudflare Worker 单文件版)
//  版本: 3.0.0 (Gateway Hardening Edition)
//  目标: 作为面向 App / 第三方客户端的最小 OpenAI 兼容图片网关
// =================================================================================

const CONFIG = {
  PROJECT_NAME: 'ai-generator-openai-gateway',
  PROJECT_VERSION: '3.0.0',
  UPSTREAM_ORIGIN: 'https://ai-image-generator.co',
  DEFAULT_MODEL: 'flux-schnell',
  ALLOWED_MODELS: ['flux-schnell'],
  ENABLE_WEB_UI: false,
  UPSTREAM_TIMEOUT_MS: 45000,
  CORS_ALLOW_ORIGIN: '*',
};

export default {
  async fetch(request, env, ctx) {
    const runtime = getRuntimeConfig(env);
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    try {
      if (request.method === 'OPTIONS') {
        return handleCorsPreflight(runtime);
      }

      if (!runtime.apiMasterKey) {
        return createErrorResponse(
          'Server is not configured: missing API_MASTER_KEY',
          500,
          'server_misconfigured',
          runtime,
          requestId,
        );
      }

      if (url.pathname === '/') {
        if (!runtime.enableWebUi) {
          return createErrorResponse(
            'Web UI is disabled',
            404,
            'not_found',
            runtime,
            requestId,
          );
        }
        return handleUI(request, runtime, requestId);
      }

      if (url.pathname === '/health') {
        return createJsonResponse(
          {
            ok: true,
            project: runtime.projectName,
            version: runtime.projectVersion,
            request_id: requestId,
          },
          200,
          runtime,
          requestId,
        );
      }

      if (url.pathname === '/v1/models') {
        return handleModelsRequest(runtime, requestId);
      }

      if (url.pathname === '/v1/chat/completions') {
        return handleChatCompletions(request, runtime, requestId);
      }

      if (url.pathname === '/v1/images/generations') {
        return handleImageGenerations(request, runtime, requestId);
      }

      return createErrorResponse(
        `Endpoint not found: ${url.pathname}`,
        404,
        'not_found',
        runtime,
        requestId,
      );
    } catch (error) {
      console.error(`[fatal][${requestId}]`, error);
      return createErrorResponse(
        error?.message || 'Internal server error',
        500,
        'internal_error',
        runtime,
        requestId,
      );
    }
  },
};

class Logger {
  constructor(requestId) {
    this.requestId = requestId;
    this.logs = [];
  }

  add(step, data) {
    const time = new Date().toISOString().split('T')[1].slice(0, -1);
    this.logs.push({ time, requestId: this.requestId, step, data });
    console.log(`[${this.requestId}][${step}]`, data);
  }

  get() {
    return this.logs;
  }
}

function getRuntimeConfig(env = {}) {
  const allowedModels = parseCsv(env.ALLOWED_MODELS) || CONFIG.ALLOWED_MODELS;
  const defaultModel = env.DEFAULT_MODEL || CONFIG.DEFAULT_MODEL;

  return {
    projectName: env.PROJECT_NAME || CONFIG.PROJECT_NAME,
    projectVersion: env.PROJECT_VERSION || CONFIG.PROJECT_VERSION,
    apiMasterKey: env.API_MASTER_KEY || '',
    upstreamOrigin: (env.UPSTREAM_ORIGIN || CONFIG.UPSTREAM_ORIGIN).replace(/\/$/, ''),
    defaultModel,
    allowedModels: allowedModels.length > 0 ? allowedModels : [defaultModel],
    enableWebUi: parseBoolean(env.ENABLE_WEB_UI, CONFIG.ENABLE_WEB_UI),
    upstreamTimeoutMs: parsePositiveInt(env.UPSTREAM_TIMEOUT_MS, CONFIG.UPSTREAM_TIMEOUT_MS),
    corsAllowOrigin: env.CORS_ALLOW_ORIGIN || CONFIG.CORS_ALLOW_ORIGIN,
  };
}

function parseCsv(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function generateFingerprint() {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 32; i += 1) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

function generateRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

function getFakeHeaders(runtime, fingerprint, anonUserId) {
  const fakeIP = generateRandomIP();
  return {
    headers: {
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/json',
      origin: runtime.upstreamOrigin,
      referer: `${runtime.upstreamOrigin}/`,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      'X-Forwarded-For': fakeIP,
      'X-Real-IP': fakeIP,
      'CF-Connecting-IP': fakeIP,
      'True-Client-IP': fakeIP,
      'X-Client-IP': fakeIP,
      Cookie: `anon_user_id=${anonUserId};`,
    },
    fakeIP,
  };
}

function verifyAuth(request, validKey) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${validKey}`;
}

async function requireJsonBody(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'invalid_content_type', 'Content-Type must be application/json');
  }

  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function ensureAuthorized(request, runtime) {
  if (!verifyAuth(request, runtime.apiMasterKey)) {
    throw new HttpError(401, 'unauthorized', 'Unauthorized');
  }
}

function ensureAllowedModel(requestedModel, runtime) {
  const model = requestedModel || runtime.defaultModel;
  if (!runtime.allowedModels.includes(model)) {
    throw new HttpError(
      400,
      'model_not_allowed',
      `Model not allowed: ${model}`,
    );
  }
  return model;
}

function normalizeAspectRatioFromSize(size) {
  switch (size) {
    case '1024x1792':
      return '9:16';
    case '1792x1024':
      return '16:9';
    case '1024x1024':
    default:
      return '1:1';
  }
}

function extractPromptFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, 'invalid_request', 'No messages found');
  }

  const lastMsg = messages[messages.length - 1];
  let prompt = '';

  if (typeof lastMsg?.content === 'string') {
    prompt = lastMsg.content;
  } else if (Array.isArray(lastMsg?.content)) {
    for (const part of lastMsg.content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        prompt += `${part.text} `;
      }
    }
  }

  prompt = prompt.trim();
  if (!prompt) {
    throw new HttpError(400, 'invalid_request', 'Prompt is empty');
  }

  return prompt;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('upstream_timeout'), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new HttpError(504, 'upstream_timeout', 'Upstream request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function performUpstreamGeneration(prompt, model, aspectRatio, logger, runtime) {
  const fingerprint = generateFingerprint();
  const anonUserId = crypto.randomUUID();
  const { headers, fakeIP } = getFakeHeaders(runtime, fingerprint, anonUserId);

  logger.add('Identity Created', {
    fingerprint,
    anonUserId,
    fakeIP,
    userAgent: headers['user-agent'],
  });

  const deductPayload = {
    trans_type: 'image_generation',
    credits: 1,
    model,
    numOutputs: 1,
    fingerprint_id: fingerprint,
  };

  try {
    logger.add('Step 1: Deduct Request', deductPayload);
    const deductRes = await fetchWithTimeout(
      `${runtime.upstreamOrigin}/api/credits/deduct`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(deductPayload),
      },
      runtime.upstreamTimeoutMs,
    );

    const deductText = await deductRes.text();
    let deductJson;
    try {
      deductJson = JSON.parse(deductText);
    } catch {
      deductJson = deductText;
    }

    logger.add('Step 1: Deduct Response', {
      status: deductRes.status,
      body: deductJson,
    });
  } catch (error) {
    logger.add('Deduct Error', error?.message || String(error));
  }

  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('model', model);
  formData.append('num_outputs', '1');
  formData.append('inputMode', 'text');
  formData.append('style', 'auto');
  formData.append('aspectRatio', aspectRatio || '1:1');
  formData.append('fingerprint_id', fingerprint);
  formData.append('provider', 'replicate');

  const genHeaders = { ...headers };
  delete genHeaders['content-type'];

  logger.add('Step 2: Generation Request', {
    url: `${runtime.upstreamOrigin}/api/gen-image`,
    provider: 'replicate',
    prompt,
    aspectRatio,
    model,
  });

  const response = await fetchWithTimeout(
    `${runtime.upstreamOrigin}/api/gen-image`,
    {
      method: 'POST',
      headers: genHeaders,
      body: formData,
    },
    runtime.upstreamTimeoutMs,
  );

  const respText = await response.text();
  let data;
  try {
    data = JSON.parse(respText);
  } catch {
    logger.add('Upstream Parse Error', respText);
    throw new HttpError(
      502,
      'upstream_invalid_response',
      `Upstream returned non-JSON: ${respText.substring(0, 200)}`,
    );
  }

  logger.add('Step 2: Upstream Response (Full)', data);

  if (!response.ok) {
    throw new HttpError(
      502,
      'upstream_error',
      `Upstream Error (${response.status}): ${JSON.stringify(data)}`,
    );
  }

  if (data?.code === 0 && Array.isArray(data.data) && data.data[0]?.url) {
    return data.data[0].url;
  }

  throw new HttpError(502, 'upstream_error', data?.message || 'Unknown upstream error');
}

async function handleChatCompletions(request, runtime, requestId) {
  const logger = new Logger(requestId);

  try {
    ensureAuthorized(request, runtime);
    const body = await requireJsonBody(request);
    const isWebUI = body.is_web_ui === true;
    const prompt = extractPromptFromMessages(body.messages);
    const model = ensureAllowedModel(body.model, runtime);
    const imageUrl = await performUpstreamGeneration(prompt, model, '1:1', logger, runtime);
    const respContent = `![Generated Image](${imageUrl})`;
    const respId = `chatcmpl-${crypto.randomUUID()}`;

    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        try {
          if (isWebUI && runtime.enableWebUi) {
            await writer.write(
              encoder.encode(`data: ${JSON.stringify({ debug: logger.get() })}\n\n`),
            );
          }

          const chunk = {
            id: respId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: respContent }, finish_reason: null }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

          const endChunk = {
            id: respId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: corsHeaders(
          {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Request-Id': requestId,
          },
          runtime,
        ),
      });
    }

    return createJsonResponse(
      {
        id: respId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: respContent },
            finish_reason: 'stop',
          },
        ],
      },
      200,
      runtime,
      requestId,
    );
  } catch (error) {
    logger.add('Fatal Error', error?.message || String(error));
    return handleError(error, runtime, requestId);
  }
}

async function handleImageGenerations(request, runtime, requestId) {
  const logger = new Logger(requestId);

  try {
    ensureAuthorized(request, runtime);
    const body = await requireJsonBody(request);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      throw new HttpError(400, 'invalid_request', 'Prompt is required');
    }

    const model = ensureAllowedModel(body.model, runtime);
    const aspectRatio = body.aspect_ratio || normalizeAspectRatioFromSize(body.size);
    const imageUrl = await performUpstreamGeneration(
      prompt,
      model,
      aspectRatio,
      logger,
      runtime,
    );

    return createJsonResponse(
      {
        created: Math.floor(Date.now() / 1000),
        data: [{ url: imageUrl }],
      },
      200,
      runtime,
      requestId,
    );
  } catch (error) {
    logger.add('Fatal Error', error?.message || String(error));
    return handleError(error, runtime, requestId);
  }
}

function handleModelsRequest(runtime, requestId) {
  return createJsonResponse(
    {
      object: 'list',
      data: runtime.allowedModels.map((id) => ({
        id,
        object: 'model',
        created: Date.now(),
        owned_by: runtime.projectName,
      })),
    },
    200,
    runtime,
    requestId,
  );
}

function handleError(error, runtime, requestId) {
  if (error instanceof HttpError) {
    return createErrorResponse(error.message, error.status, error.code, runtime, requestId);
  }

  console.error(`[error][${requestId}]`, error);
  return createErrorResponse(
    error?.message || 'Internal server error',
    500,
    'internal_error',
    runtime,
    requestId,
  );
}

function createJsonResponse(body, status, runtime, requestId) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(
      {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      runtime,
    ),
  });
}

function createErrorResponse(message, status, code, runtime, requestId) {
  return createJsonResponse(
    {
      error: {
        message,
        type: 'api_error',
        code,
        request_id: requestId,
      },
    },
    status,
    runtime,
    requestId,
  );
}

function handleCorsPreflight(runtime) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders({}, runtime),
  });
}

function corsHeaders(headers = {}, runtime) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': runtime.corsAllowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function handleUI(request, runtime, requestId) {
  const origin = new URL(request.url).origin;
  const apiKeyHint = runtime.apiMasterKey ? maskSecret(runtime.apiMasterKey) : '(missing)';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${runtime.projectName} - 控制台</title>
  <style>
    :root { --bg: #09090b; --panel: #18181b; --border: #27272a; --text: #e4e4e7; --primary: #f59e0b; --accent: #3b82f6; --code-bg: #000000; }
    body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; min-height: 100vh; display: flex; overflow: hidden; }
    .sidebar { width: 360px; background: var(--panel); border-right: 1px solid var(--border); padding: 24px; display: flex; flex-direction: column; overflow-y: auto; }
    .main { flex: 1; display: flex; flex-direction: column; padding: 24px; background-color: #000; }
    h2 { margin-top: 0; font-size: 20px; color: #fff; display: flex; align-items: center; gap: 10px; }
    .badge { background: var(--primary); color: #000; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
    .box { background: #27272a; padding: 16px; border-radius: 8px; border: 1px solid #3f3f46; margin-bottom: 20px; }
    .label { font-size: 12px; color: #a1a1aa; margin-bottom: 8px; display: block; font-weight: 600; }
    .code-block { font-family: 'Consolas', monospace; font-size: 12px; color: var(--primary); background: #111; padding: 10px; border-radius: 6px; word-break: break-all; border: 1px solid #333; }
    input, select, textarea { width: 100%; background: #18181b; border: 1px solid #3f3f46; color: #fff; padding: 10px; border-radius: 6px; margin-bottom: 12px; box-sizing: border-box; font-family: inherit; }
    button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 6px; font-weight: bold; cursor: pointer; color: #000; font-size: 14px; }
    button:disabled { background: #3f3f46; color: #71717a; cursor: not-allowed; }
    .result-area { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; background: radial-gradient(circle at center, #1a1a1a 0%, #000 100%); border-radius: 12px; border: 1px solid var(--border); }
    .result-img { max-width: 95%; max-height: 95%; border-radius: 8px; box-shadow: 0 0 30px rgba(0,0,0,0.7); }
    .status-bar { min-height: 30px; display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: #71717a; margin-top: 12px; padding: 0 4px; }
    .spinner { width: 24px; height: 24px; border: 3px solid #333; border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .log-panel { height: 220px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-y: auto; font-family: 'Consolas', monospace; font-size: 11px; color: #a1a1aa; margin-top: 10px; }
    .log-entry { margin-bottom: 8px; border-bottom: 1px solid #1a1a1a; padding-bottom: 8px; }
    .log-time { color: #52525b; margin-right: 8px; }
    .log-key { color: var(--accent); font-weight: bold; margin-right: 8px; }
    .log-json { color: #86efac; white-space: pre-wrap; display: block; margin-top: 4px; padding-left: 10px; border-left: 2px solid #333; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2>🎨 Gateway Console <span class="badge">${runtime.projectVersion}</span></h2>
    <div class="box">
      <span class="label">Request ID</span>
      <div class="code-block">${requestId}</div>
    </div>
    <div class="box">
      <span class="label">API 密钥（掩码显示）</span>
      <div class="code-block">${apiKeyHint}</div>
    </div>
    <div class="box">
      <span class="label">API 地址</span>
      <div class="code-block">${origin}/v1/chat/completions</div>
    </div>
    <div class="box">
      <span class="label">模型 (Model)</span>
      <select id="model">
        ${runtime.allowedModels
          .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
          .join('')}
      </select>
      <span class="label">比例 (Aspect Ratio)</span>
      <select id="ratio">
        <option value="1:1">1:1 (方形)</option>
        <option value="16:9">16:9 (横屏)</option>
        <option value="9:16">9:16 (竖屏)</option>
      </select>
      <span class="label">提示词 (Prompt)</span>
      <textarea id="prompt" rows="6" placeholder="描述你想生成的图片..."></textarea>
      <button id="btn-gen" onclick="generate()">🚀 开始生成</button>
    </div>
  </div>
  <main class="main">
    <div class="result-area" id="result-container">
      <div style="color:#3f3f46; text-align:center;">
        <p>图片预览区域</p>
        <div class="spinner" id="spinner"></div>
      </div>
    </div>
    <div class="status-bar">
      <span id="status-text">系统就绪</span>
      <span id="time-text"></span>
    </div>
    <div class="log-panel" id="logs">
      <div style="color:#52525b">// 等待请求... 日志将显示在这里</div>
    </div>
  </main>
  <script>
    const ENDPOINT = ${JSON.stringify(`${origin}/v1/chat/completions`)};
    const API_KEY = prompt('请输入 API 密钥以测试当前 Worker');

    function appendLog(step, data) {
      const logs = document.getElementById('logs');
      const div = document.createElement('div');
      div.className = 'log-entry';
      const time = new Date().toLocaleTimeString();
      const content = typeof data === 'object'
        ? `<span class="log-json">${escapeForHtml(JSON.stringify(data, null, 2))}</span>`
        : `<span style="color:#e4e4e7">${escapeForHtml(String(data))}</span>`;
      div.innerHTML = `<span class="log-time">[${time}]</span><span class="log-key">${escapeForHtml(step)}</span>${content}`;
      if (logs.innerText.includes('// 等待请求')) logs.innerHTML = '';
      logs.appendChild(div);
      logs.scrollTop = logs.scrollHeight;
    }

    function escapeForHtml(text) {
      return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    async function generate() {
      if (!API_KEY) {
        alert('没有输入 API 密钥，无法测试。');
        return;
      }

      const promptEl = document.getElementById('prompt');
      const prompt = promptEl ? promptEl.value.trim() : '';
      if (!prompt) return alert('请输入提示词');

      const btn = document.getElementById('btn-gen');
      const spinner = document.getElementById('spinner');
      const status = document.getElementById('status-text');
      const container = document.getElementById('result-container');
      const logs = document.getElementById('logs');
      const timeText = document.getElementById('time-text');
      const model = document.getElementById('model').value;
      const ratio = document.getElementById('ratio').value;

      if (btn) { btn.disabled = true; btn.innerText = '生成中...'; }
      if (spinner) spinner.style.display = 'inline-block';
      if (status) status.innerText = '正在连接上游 API...';
      if (container) container.innerHTML = '<div class="spinner" style="display:block"></div>';
      if (logs) logs.innerHTML = '';

      const startTime = Date.now();

      try {
        const payload = {
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          is_web_ui: true,
          aspect_ratio: ratio,
        };

        appendLog('System', 'Initiating request to Worker...');
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error?.message || `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') break;
            try {
              const json = JSON.parse(jsonStr);
              if (json.debug) {
                json.debug.forEach(log => appendLog(log.step, log.data));
                continue;
              }
              if (json.choices && json.choices[0]?.delta?.content) {
                fullContent += json.choices[0].delta.content;
              }
            } catch (error) {
              appendLog('Parse Warning', String(error));
            }
          }
        }

        const match = fullContent.match(/\((.*?)\)/);
        if (match && match[1]) {
          const imgUrl = match[1];
          if (container) container.innerHTML = `<img src="${imgUrl}" class="result-img">`;
          if (status) status.innerText = '生成成功';
          if (timeText) timeText.innerText = `耗时: ${((Date.now() - startTime) / 1000).toFixed(2)}s`;
          appendLog('Success', 'Image URL extracted: ' + imgUrl);
        } else {
          throw new Error('无法从响应中提取图片 URL');
        }
      } catch (error) {
        if (container) container.innerHTML = `<div style="color:#ef4444; padding:20px; text-align:center">❌ ${escapeForHtml(String(error.message || error))}</div>`;
        if (status) status.innerText = '发生错误';
        appendLog('Error', error.message || String(error));
      } finally {
        if (btn) { btn.disabled = false; btn.innerText = '🚀 开始生成'; }
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Request-Id': requestId,
    },
  });
}

function maskSecret(value) {
  if (!value) return '(missing)';
  if (value.length <= 8) return `${value.slice(0, 1)}***${value.slice(-1)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
