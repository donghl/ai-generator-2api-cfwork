// =================================================================================
//  项目: ai-generator-2api (Cloudflare Worker 单文件版)
//  版本: 3.1.0
//  目标: 面向 App / 第三方客户端的最小 OpenAI 兼容 AI 网关
//  能力: text -> Ollama, vision -> Ollama, image -> ComfyUI, video -> ComfyUI
// =================================================================================

const CONFIG = {
  PROJECT_NAME: 'ai-generator-openai-gateway',
  PROJECT_VERSION: '3.1.0',
  ENABLE_WEB_UI: false,
  UPSTREAM_TIMEOUT_MS: 60000,
  CORS_ALLOW_ORIGIN: '*',
  OLLAMA_BASE_URL: 'https://honglei.synology.me:11434',
  COMFYUI_BASE_URL: 'https://honglei.synology.me:8188',
  DEFAULT_TEXT_MODEL: '',
  DEFAULT_VISION_MODEL: '',
  TEXT_MODEL_ALLOWLIST: [],
  VISION_MODEL_ALLOWLIST: [],
  IMAGE_WORKFLOW_JSON: '',
  VIDEO_WORKFLOW_JSON: '',
  TASKS_KV_PREFIX: 'task',
};

export default {
  async fetch(request, env) {
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
          return createErrorResponse('Web UI is disabled', 404, 'not_found', runtime, requestId);
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
            capabilities: ['text', 'vision', 'image', 'video'],
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

      if (url.pathname === '/v1/videos/generations') {
        return handleVideoGenerations(request, runtime, requestId);
      }

      if (url.pathname.startsWith('/v1/tasks/')) {
        const taskId = decodeURIComponent(url.pathname.replace('/v1/tasks/', ''));
        return handleTaskLookup(request, runtime, requestId, taskId);
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

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function getRuntimeConfig(env = {}) {
  return {
    projectName: env.PROJECT_NAME || CONFIG.PROJECT_NAME,
    projectVersion: env.PROJECT_VERSION || CONFIG.PROJECT_VERSION,
    apiMasterKey: env.API_MASTER_KEY || '',
    enableWebUi: parseBoolean(env.ENABLE_WEB_UI, CONFIG.ENABLE_WEB_UI),
    upstreamTimeoutMs: parsePositiveInt(env.UPSTREAM_TIMEOUT_MS, CONFIG.UPSTREAM_TIMEOUT_MS),
    corsAllowOrigin: env.CORS_ALLOW_ORIGIN || CONFIG.CORS_ALLOW_ORIGIN,
    ollamaBaseUrl: normalizeBaseUrl(env.OLLAMA_BASE_URL || CONFIG.OLLAMA_BASE_URL),
    comfyuiBaseUrl: normalizeBaseUrl(env.COMFYUI_BASE_URL || CONFIG.COMFYUI_BASE_URL),
    defaultTextModel: env.DEFAULT_TEXT_MODEL || CONFIG.DEFAULT_TEXT_MODEL,
    defaultVisionModel: env.DEFAULT_VISION_MODEL || CONFIG.DEFAULT_VISION_MODEL,
    textModelAllowlist: parseCsv(env.TEXT_MODEL_ALLOWLIST),
    visionModelAllowlist: parseCsv(env.VISION_MODEL_ALLOWLIST),
    imageWorkflow: parseJsonObject(env.IMAGE_WORKFLOW_JSON || CONFIG.IMAGE_WORKFLOW_JSON),
    videoWorkflow: parseJsonObject(env.VIDEO_WORKFLOW_JSON || CONFIG.VIDEO_WORKFLOW_JSON),
    tasksKvPrefix: env.TASKS_KV_PREFIX || CONFIG.TASKS_KV_PREFIX,
    taskStore: env.TASKS,
  };
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/$/, '');
}

function parseCsv(value) {
  if (!value || typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function verifyAuth(request, validKey) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${validKey}`;
}

function ensureAuthorized(request, runtime) {
  if (!verifyAuth(request, runtime.apiMasterKey)) {
    throw new HttpError(401, 'unauthorized', 'Unauthorized');
  }
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

function requirePrompt(value) {
  const prompt = String(value || '').trim();
  if (!prompt) {
    throw new HttpError(400, 'invalid_request', 'Prompt is required');
  }
  return prompt;
}

function inferCapabilityFromMessages(messages) {
  for (const message of messages || []) {
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'image_url' || part?.type === 'input_image') {
          return 'vision';
        }
      }
    }
  }
  return 'text';
}

function extractPromptFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, 'invalid_request', 'No messages found');
  }

  const textParts = [];
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') {
      textParts.push(`${message.role || 'user'}: ${content}`);
      continue;
    }
    if (Array.isArray(content)) {
      const collected = [];
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          collected.push(part.text.trim());
        }
      }
      if (collected.length > 0) {
        textParts.push(`${message.role || 'user'}: ${collected.join(' ')}`);
      }
    }
  }

  const prompt = textParts.join('\n').trim();
  if (!prompt) {
    throw new HttpError(400, 'invalid_request', 'Prompt is empty');
  }
  return prompt;
}

function extractImagesFromMessages(messages) {
  const images = [];
  for (const message of messages || []) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (url) images.push(url);
      }
      if (part?.type === 'input_image') {
        const url = part.image_url || part.url;
        if (url) images.push(url);
      }
    }
  }
  return images;
}

function selectModel(capability, requestedModel, runtime) {
  const allowlist = capability === 'vision' ? runtime.visionModelAllowlist : runtime.textModelAllowlist;
  const fallback = capability === 'vision' ? runtime.defaultVisionModel : runtime.defaultTextModel;
  const model = requestedModel || fallback;

  if (!model) {
    throw new HttpError(400, 'missing_model', `Missing model for capability: ${capability}`);
  }

  if (allowlist.length > 0 && !allowlist.includes(model)) {
    throw new HttpError(400, 'model_not_allowed', `Model not allowed for ${capability}: ${model}`);
  }

  return model;
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

function buildOllamaChatPayload({ capability, model, messages, prompt, images, stream = false }) {
  const ollamaMessages = Array.isArray(messages) && messages.length > 0
    ? messages.map((message) => normalizeOllamaMessage(message))
    : [{ role: 'user', content: prompt, ...(images?.length ? { images } : {}) }];

  if (capability === 'vision' && images?.length) {
    const lastUserIndex = [...ollamaMessages].reverse().findIndex((message) => message.role === 'user');
    if (lastUserIndex !== -1) {
      const idx = ollamaMessages.length - 1 - lastUserIndex;
      ollamaMessages[idx] = {
        ...ollamaMessages[idx],
        images,
      };
    }
  }

  return {
    model,
    messages: ollamaMessages,
    stream,
  };
}

async function callOllamaChat({ capability, model, messages, prompt, images, logger, runtime }) {
  const endpoint = `${runtime.ollamaBaseUrl}/api/chat`;
  const payload = buildOllamaChatPayload({ capability, model, messages, prompt, images, stream: false });

  logger.add('Ollama Request', { endpoint, capability, model, payload });
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    runtime.upstreamTimeoutMs,
  );

  const data = await safeReadJson(response);
  logger.add('Ollama Response', { status: response.status, data });

  if (!response.ok) {
    throw new HttpError(502, 'upstream_error', `Ollama error (${response.status}): ${JSON.stringify(data)}`);
  }

  const content = data?.message?.content;
  if (!content) {
    throw new HttpError(502, 'upstream_invalid_response', 'Ollama response missing message.content');
  }

  return {
    content: stripThinkTags(content),
    usage: buildOllamaUsage(data),
  };
}

async function callOllamaChatStream({ capability, model, messages, prompt, images, logger, runtime, onDelta }) {
  const endpoint = `${runtime.ollamaBaseUrl}/api/chat`;
  const payload = buildOllamaChatPayload({ capability, model, messages, prompt, images, stream: true });

  logger.add('Ollama Stream Request', { endpoint, capability, model, payload });
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    runtime.upstreamTimeoutMs,
  );

  if (!response.ok) {
    const data = await safeReadJson(response);
    logger.add('Ollama Stream Error', { status: response.status, data });
    throw new HttpError(502, 'upstream_error', `Ollama error (${response.status}): ${JSON.stringify(data)}`);
  }

  if (!response.body) {
    throw new HttpError(502, 'upstream_invalid_response', 'Ollama stream response missing body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let data;
      try {
        data = JSON.parse(line);
      } catch {
        logger.add('Ollama Stream Parse Skip', { line });
        continue;
      }

      if (data?.error) {
        throw new HttpError(502, 'upstream_error', `Ollama stream error: ${data.error}`);
      }

      const content = stripThinkTags(data?.message?.content || '');
      if (content) {
        await onDelta(content);
      }

      if (data?.done) {
        usage = buildOllamaUsage(data);
      }
    }
  }

  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer.trim());
      if (data?.error) {
        throw new HttpError(502, 'upstream_error', `Ollama stream error: ${data.error}`);
      }
      const content = stripThinkTags(data?.message?.content || '');
      if (content) {
        await onDelta(content);
      }
      if (data?.done) {
        usage = buildOllamaUsage(data);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      logger.add('Ollama Stream Tail Parse Skip', { buffer: buffer.trim() });
    }
  }

  return { usage };
}

function normalizeOllamaMessage(message) {
  const role = message?.role || 'user';
  const content = message?.content;

  if (typeof content === 'string') {
    return { role, content };
  }

  if (Array.isArray(content)) {
    const text = [];
    const images = [];
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        text.push(part.text);
      }
      if (part?.type === 'image_url') {
        const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (imageUrl) images.push(stripDataUrlPrefix(imageUrl));
      }
      if (part?.type === 'input_image') {
        const imageUrl = part.image_url || part.url;
        if (imageUrl) images.push(stripDataUrlPrefix(imageUrl));
      }
    }

    const normalized = { role, content: text.join('\n').trim() };
    if (images.length > 0) normalized.images = images;
    return normalized;
  }

  return { role, content: '' };
}

function stripDataUrlPrefix(value) {
  const stringValue = String(value || '');
  const marker = 'base64,';
  const index = stringValue.indexOf(marker);
  return index >= 0 ? stringValue.slice(index + marker.length) : stringValue;
}

function stripThinkTags(content) {
  return String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

function buildOllamaUsage(data) {
  const promptTokens = data?.prompt_eval_count || 0;
  const completionTokens = data?.eval_count || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

async function safeReadJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyWorkflowPlaceholders(nodeValue, replacements) {
  if (typeof nodeValue === 'string') {
    let result = nodeValue;
    for (const [key, replacement] of Object.entries(replacements)) {
      result = result.replaceAll(`{{${key}}}`, replacement == null ? '' : String(replacement));
    }
    return result;
  }

  if (Array.isArray(nodeValue)) {
    return nodeValue.map((item) => applyWorkflowPlaceholders(item, replacements));
  }

  if (nodeValue && typeof nodeValue === 'object') {
    return Object.fromEntries(
      Object.entries(nodeValue).map(([key, value]) => [key, applyWorkflowPlaceholders(value, replacements)]),
    );
  }

  return nodeValue;
}

function buildComfyWorkflow(kind, runtime, params) {
  const template = kind === 'video' ? runtime.videoWorkflow : runtime.imageWorkflow;
  if (!template) {
    throw new HttpError(
      500,
      'workflow_not_configured',
      `${kind} workflow is not configured. Set ${kind === 'video' ? 'VIDEO_WORKFLOW_JSON' : 'IMAGE_WORKFLOW_JSON'}.`,
    );
  }

  return applyWorkflowPlaceholders(cloneJson(template), params);
}

async function submitComfyWorkflow(kind, workflow, logger, runtime) {
  const clientId = crypto.randomUUID();
  const endpoint = `${runtime.comfyuiBaseUrl}/prompt`;
  const payload = {
    client_id: clientId,
    prompt: workflow,
  };

  logger.add('ComfyUI Submit Request', { kind, endpoint, payload });
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    runtime.upstreamTimeoutMs,
  );
  const data = await safeReadJson(response);
  logger.add('ComfyUI Submit Response', { status: response.status, data });

  if (!response.ok || !data?.prompt_id) {
    throw new HttpError(502, 'upstream_error', `ComfyUI submit failed: ${JSON.stringify(data)}`);
  }

  return {
    clientId,
    promptId: data.prompt_id,
    number: data.number,
  };
}

async function fetchComfyHistory(promptId, logger, runtime) {
  const endpoint = `${runtime.comfyuiBaseUrl}/history/${encodeURIComponent(promptId)}`;
  logger.add('ComfyUI History Request', { endpoint, promptId });
  const response = await fetchWithTimeout(endpoint, { method: 'GET' }, runtime.upstreamTimeoutMs);
  const data = await safeReadJson(response);
  logger.add('ComfyUI History Response', { status: response.status, data });

  if (!response.ok) {
    throw new HttpError(502, 'upstream_error', `ComfyUI history failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function extractComfyOutputs(historyData, promptId, runtime) {
  const item = historyData?.[promptId];
  const outputs = [];
  if (!item?.outputs || typeof item.outputs !== 'object') {
    return outputs;
  }

  for (const nodeOutput of Object.values(item.outputs)) {
    if (Array.isArray(nodeOutput?.images)) {
      for (const image of nodeOutput.images) {
        if (!image?.filename) continue;
        const params = new URLSearchParams({
          filename: image.filename,
          subfolder: image.subfolder || '',
          type: image.type || 'output',
        });
        outputs.push({
          type: 'image',
          url: `${runtime.comfyuiBaseUrl}/view?${params.toString()}`,
          filename: image.filename,
          subfolder: image.subfolder || '',
        });
      }
    }

    if (Array.isArray(nodeOutput?.gifs)) {
      for (const gif of nodeOutput.gifs) {
        if (!gif?.filename) continue;
        const params = new URLSearchParams({
          filename: gif.filename,
          subfolder: gif.subfolder || '',
          type: gif.type || 'output',
        });
        outputs.push({
          type: 'video',
          url: `${runtime.comfyuiBaseUrl}/view?${params.toString()}`,
          filename: gif.filename,
          subfolder: gif.subfolder || '',
        });
      }
    }
  }

  return outputs;
}

async function saveTask(runtime, task) {
  if (!runtime.taskStore || typeof runtime.taskStore.put !== 'function') {
    return;
  }
  await runtime.taskStore.put(`${runtime.tasksKvPrefix}:${task.id}`, JSON.stringify(task));
}

async function loadTask(runtime, taskId) {
  if (!runtime.taskStore || typeof runtime.taskStore.get !== 'function') {
    return null;
  }
  const raw = await runtime.taskStore.get(`${runtime.tasksKvPrefix}:${taskId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildTaskResponse(task, runtime, requestId) {
  return createJsonResponse(task, 200, runtime, requestId);
}

async function handleChatCompletions(request, runtime, requestId) {
  const logger = new Logger(requestId);

  try {
    ensureAuthorized(request, runtime);
    const body = await requireJsonBody(request);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const capability = inferCapabilityFromMessages(messages);
    const prompt = extractPromptFromMessages(messages);
    const images = capability === 'vision' ? extractImagesFromMessages(messages).map(stripDataUrlPrefix) : [];
    const model = selectModel(capability, body.model, runtime);
    const respId = `chatcmpl-${crypto.randomUUID()}`;

    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        try {
          if (body.is_web_ui === true && runtime.enableWebUi) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ debug: logger.get() })}\n\n`));
          }

          let sentRole = false;
          await callOllamaChatStream({
            capability,
            model,
            messages,
            prompt,
            images,
            logger,
            runtime,
            onDelta: async (content) => {
              const delta = sentRole
                ? { content }
                : { role: 'assistant', content };
              sentRole = true;
              await writer.write(encoder.encode(`data: ${JSON.stringify({
                id: respId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta, finish_reason: null }],
              })}\n\n`));
            },
          });

          if (!sentRole) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              id: respId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            })}\n\n`));
          }

          await writer.write(encoder.encode(`data: ${JSON.stringify({
            id: respId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`));
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch (error) {
          logger.add('Stream Fatal Error', error?.message || String(error));
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            error: {
              message: error?.message || 'Stream failed',
              type: error?.code || 'stream_error',
            },
          })}\n\n`));
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: corsHeaders(
          {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Request-Id': requestId,
          },
          runtime,
        ),
      });
    }

    const result = await callOllamaChat({ capability, model, messages, prompt, images, logger, runtime });

    return createJsonResponse(
      {
        id: respId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.content },
            finish_reason: 'stop',
          },
        ],
        usage: result.usage,
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


function applyWorkflowInputs(workflow, inputs) {
  // Best-effort injection: replace matching input nodes by key if present.
  // If your workflow uses a different schema, adjust this mapping.
  if (!workflow || !workflow.nodes) return workflow;
  for (const node of workflow.nodes) {
    if (!node || !node.inputs) continue;
    for (const [key, value] of Object.entries(inputs)) {
      if (value === undefined || value === null || value === '') continue;
      if (key in node.inputs) {
        node.inputs[key] = value;
      }
    }
  }
  return workflow;
}

async function handleImageGenerations(request, runtime, requestId) {
  const logger = new Logger(requestId);

  try {
    ensureAuthorized(request, runtime);
    const body = await requireJsonBody(request);
    const prompt = requirePrompt(body.prompt);
    const aspectRatio = body.aspect_ratio || normalizeAspectRatioFromSize(body.size);
    const workflowId = body.workflow_id;
    if (!workflowId || typeof workflowId !== 'string') {
      throw createHttpError(400, 'workflow_id is required');
    }
    const workflowKey = `comfyui/images_json/${workflowId}.json`;
    const workflowObject = await runtime.R2.get(workflowKey);
    if (!workflowObject) {
      throw createHttpError(404, `workflow not found: ${workflowId}`);
    }
    const workflowText = await workflowObject.text();
    let workflow;
    try {
      workflow = JSON.parse(workflowText);
    } catch (e) {
      throw createHttpError(500, `invalid workflow json: ${workflowId}`);
    }
    // inject dynamic params if needed
    workflow = applyWorkflowInputs(workflow, {
      prompt,
      negative_prompt: body.negative_prompt || '',
      aspect_ratio: aspectRatio,
      size: body.size || '',
      image_count: body.n || 1,
      ref_image: body.ref_image || '',
    });


    const submission = await submitComfyWorkflow('image', workflow, logger, runtime);
    const task = {
      id: submission.promptId,
      object: 'task',
      type: 'image',
      status: 'submitted',
      upstream: 'comfyui',
      created_at: new Date().toISOString(),
      request_id: requestId,
      prompt,
      output: [],
    };
    await saveTask(runtime, task);

    return createJsonResponse(
      {
        created: Math.floor(Date.now() / 1000),
        data: [],
        task: {
          id: task.id,
          status: task.status,
          poll_url: `/v1/tasks/${encodeURIComponent(task.id)}`,
        },
      },
      202,
      runtime,
      requestId,
    );
  } catch (error) {
    logger.add('Fatal Error', error?.message || String(error));
    return handleError(error, runtime, requestId);
  }
}

async function handleVideoGenerations(request, runtime, requestId) {
  const logger = new Logger(requestId);

  try {
    ensureAuthorized(request, runtime);
    const body = await requireJsonBody(request);
    const prompt = requirePrompt(body.prompt);

    const workflow = buildComfyWorkflow('video', runtime, {
      prompt,
      model: body.model || '',
      duration: body.duration || '',
      aspect_ratio: body.aspect_ratio || '',
      size: body.size || '',
      negative_prompt: body.negative_prompt || '',
      reference_image: body.reference_image || '',
    });

    const submission = await submitComfyWorkflow('video', workflow, logger, runtime);
    const task = {
      id: submission.promptId,
      object: 'task',
      type: 'video',
      status: 'submitted',
      upstream: 'comfyui',
      created_at: new Date().toISOString(),
      request_id: requestId,
      prompt,
      output: [],
    };
    await saveTask(runtime, task);

    return createJsonResponse(
      {
        created: Math.floor(Date.now() / 1000),
        task: {
          id: task.id,
          status: task.status,
          poll_url: `/v1/tasks/${encodeURIComponent(task.id)}`,
        },
      },
      202,
      runtime,
      requestId,
    );
  } catch (error) {
    logger.add('Fatal Error', error?.message || String(error));
    return handleError(error, runtime, requestId);
  }
}

async function handleTaskLookup(request, runtime, requestId, taskId) {
  const logger = new Logger(requestId);

  try {
    ensureAuthorized(request, runtime);

    const stored = await loadTask(runtime, taskId);
    const type = stored?.type || 'unknown';
    const history = await fetchComfyHistory(taskId, logger, runtime);
    const outputs = extractComfyOutputs(history, taskId, runtime);

    let status = 'running';
    if (outputs.length > 0) {
      status = 'completed';
    } else if (history?.[taskId]?.status?.status_str) {
      const rawStatus = String(history[taskId].status.status_str).toLowerCase();
      if (rawStatus.includes('error')) status = 'failed';
      else if (rawStatus.includes('success')) status = 'completed';
      else if (rawStatus.includes('queue')) status = 'queued';
    } else if (stored) {
      status = stored.status;
    }

    const task = {
      id: taskId,
      object: 'task',
      type,
      status,
      upstream: 'comfyui',
      created_at: stored?.created_at || null,
      updated_at: new Date().toISOString(),
      output: outputs,
    };

    await saveTask(runtime, task);
    return buildTaskResponse(task, runtime, requestId);
  } catch (error) {
    logger.add('Fatal Error', error?.message || String(error));
    return handleError(error, runtime, requestId);
  }
}

async function fetchOllamaModels(runtime) {
  const endpoint = `${runtime.ollamaBaseUrl}/api/tags`;
  const response = await fetchWithTimeout(endpoint, { method: 'GET' }, runtime.upstreamTimeoutMs);
  const data = await safeReadJson(response);

  if (!response.ok) {
    throw new HttpError(502, 'upstream_error', `Ollama model list error (${response.status}): ${JSON.stringify(data)}`);
  }

  if (!Array.isArray(data?.models)) {
    return [];
  }

  return data.models
    .map((item) => String(item?.name || item?.model || '').trim())
    .filter(Boolean);
}

async function handleModelsRequest(runtime, requestId) {
  let textModels = runtime.textModelAllowlist.length > 0
    ? runtime.textModelAllowlist
    : runtime.defaultTextModel ? [runtime.defaultTextModel] : [];
  let visionModels = runtime.visionModelAllowlist.length > 0
    ? runtime.visionModelAllowlist
    : runtime.defaultVisionModel ? [runtime.defaultVisionModel] : [];

  if (textModels.length === 0 && visionModels.length === 0) {
    const discovered = await fetchOllamaModels(runtime);
    textModels = discovered;
    visionModels = discovered;
  }

  const seen = new Set();
  const models = [
    ...textModels
      .filter((id) => {
        const key = `text:${id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((id) => ({ id, object: 'model', created: Date.now(), owned_by: 'ollama', capability: 'text' })),
    ...visionModels
      .filter((id) => {
        const key = `vision:${id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((id) => ({ id, object: 'model', created: Date.now(), owned_by: 'ollama', capability: 'vision' })),
    { id: 'comfyui-image', object: 'model', created: Date.now(), owned_by: 'comfyui', capability: 'image' },
    { id: 'comfyui-video', object: 'model', created: Date.now(), owned_by: 'comfyui', capability: 'video' },
  ];

  return createJsonResponse({ object: 'list', data: models }, 200, runtime, requestId);
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

function handleUI(request, runtime, requestId) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${runtime.projectName}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #09090b; color: #e4e4e7; margin: 0; padding: 32px; }
    .card { max-width: 900px; margin: 0 auto; background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 24px; }
    code, pre { background: #111; color: #f59e0b; padding: 2px 6px; border-radius: 6px; }
    pre { padding: 16px; overflow: auto; }
    h1, h2 { margin-top: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>AI Gateway Console</h1>
    <p>Request ID: <code>${escapeHtml(requestId)}</code></p>
    <p>Capabilities: <code>text</code> <code>vision</code> <code>image</code> <code>video</code></p>
    <h2>Endpoints</h2>
    <pre>${escapeHtml(`${origin}/health
${origin}/v1/models
${origin}/v1/chat/completions
${origin}/v1/images/generations
${origin}/v1/videos/generations
${origin}/v1/tasks/:id`)}</pre>
    <h2>Upstreams</h2>
    <pre>${escapeHtml(JSON.stringify({
      ollama: runtime.ollamaBaseUrl,
      comfyui: runtime.comfyuiBaseUrl,
      textModels: runtime.textModelAllowlist,
      visionModels: runtime.visionModelAllowlist,
    }, null, 2))}</pre>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Request-Id': requestId,
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
