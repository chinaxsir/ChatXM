import AsyncStorage from '@react-native-async-storage/async-storage';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';

const BASE_API_URL = "https://gate.127110.xyz";

// 自动清洗 endpoint：去掉尾部斜杠 + /v1 及其后的路径，返回 base URL
function normalizeEndpoint(url: string): string {
  if (!url) return '';
  let base = url.trim().replace(/\/+$/,'');
  const idx = base.toLowerCase().indexOf('/v1');
  if (idx > -1) base = base.substring(0, idx);
  return base.replace(/\/+$/,'');
}

// 剥离 HTML 标签并解码实体，用于把服务器返回的 HTML 错误页转成纯文本
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// HTTP 状态码 → 友好提示
const STATUS_HINTS: Record<number, string> = {
  400: '请求格式错误',
  401: 'API Key 无效或缺，请先登录后在账户页面确认已生成 API Key',
  403: '无权限访问该接口',
  404: '接口地址不存在，请检查 Endpoint 配置是否正确',
  408: '请求超时，请检查网络后重试',
  429: '请求过于频繁，请稍后重试',
  500: '服务器内部错误',
  502: '网关错误',
  503: '上游 AI 节点暂不可用，请稍后重试',
  504: '网关超时',
};

// 构造用户友好的错误提示：优先状态码提示，其次尝试解析响应体（JSON/纯文本），最后兜底
function friendlyError(status: number, rawText: string): string {
  const hint = STATUS_HINTS[status];
  let detail = '';
  const trimmed = rawText?.trim() || '';
  if (trimmed) {
    // 尝试解析 JSON 错误（OpenAI 兼容格式：{ error: { message: "..." } }）
    try {
      const obj = JSON.parse(trimmed);
      detail = obj?.error?.message || obj?.message || obj?.error || '';
    } catch {
      // 非 JSON，剥离 HTML 后取前 80 字符
      const plain = stripHtml(trimmed);
      detail = plain.length > 80 ? plain.slice(0, 80) + '...' : plain;
    }
  }
  if (hint && detail) return `${hint}（${detail}）`;
  if (hint) return hint;
  if (detail) return detail;
  return `HTTP ${status} 请求失败`;
}

// 本地存储 JSON 解析兜底：数据损坏时返回 fallback，避免启动/读取即崩溃
function safeParse(raw: string | null, fallback: any): any {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// 判断是否「上游临时繁忙」类错误：这类错误重试即可能成功，不该直接抛给用户。
// 网关常见文案：当前并发量较大，请 300 秒后重试 / 上游繁忙 / 渠道排队 / overloaded
const TRANSIENT_PATTERN = /并发量较大|并发|繁忙|排队|拥挤|请.*秒后重试|稍后重试|rate limit|overload|too many requests|temporarily unavailable/i;

function isTransientError(status: number, rawText: string): boolean {
  if (status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return TRANSIENT_PATTERN.test(rawText || '');
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 构造用户消息内容：支持纯文本 / 文本+图片 / 文本+音频 / 文本+图片+音频
function buildUserContent(args: any): any {
  const hasMedia = args.image || args.audio;
  if (!hasMedia) {
    return { role: 'user', content: args.prompt };
  }
  const content: any[] = [];
  if (args.prompt) content.push({ type: 'text', text: args.prompt });
  if (args.image) content.push({ type: 'image_url', image_url: { url: args.image } });
  if (args.audio) content.push({ type: 'audio_url', audio_url: { url: args.audio } });
  return { role: 'user', content };
}

// 清洗本地历史消息：仅保留 OpenAI 协议要求的 role/content，
// 剥离 displayContent/fileName/audio 等 UI 字段与空消息，避免接口 400。
// 图片上下文：只把「最近 1 条」带图的历史消息还原为多模态结构。
// 若每条历史图片都重传，请求体随轮次线性膨胀（每张 base64 数百 KB），
// 会触发 iOS fetch 崩溃 / 网关拒绝，反而让图片对话整体不可用。
const HISTORY_IMAGE_LIMIT = 1;

function messageHasImage(m: any): boolean {
  if (Array.isArray(m?.content)) return m.content.some((p: any) => p?.type === 'image_url');
  return !!m?.image;
}

function sanitizeMessages(raw: any[]): any[] {
  const list = Array.isArray(raw) ? raw : [];

  // 倒序分配图片额度：保证保留的是「最近发的那张图」
  const keepImageAt = new Set<number>();
  let quota = HISTORY_IMAGE_LIMIT;
  for (let i = list.length - 1; i >= 0 && quota > 0; i--) {
    if (messageHasImage(list[i])) {
      keepImageAt.add(i);
      quota -= 1;
    }
  }

  return list
    .map((m: any, idx: number) => {
      if (!m) return null;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const keepImage = keepImageAt.has(idx);

      // content 已经是多模态数组
      if (Array.isArray(m.content) && m.content.length > 0) {
        if (keepImage) return { role, content: m.content };
        // 超出额度的历史图片剔除，只留文本部分
        const textOnly = m.content
          .filter((p: any) => p?.type === 'text')
          .map((p: any) => p?.text || '')
          .join('\n');
        return textOnly.trim() ? { role, content: textOnly } : null;
      }

      // content 是 string，但消息带图片字段
      if (m.image) {
        if (keepImage) {
          const content: any[] = [];
          if (typeof m.content === 'string' && m.content.trim()) {
            content.push({ type: 'text', text: m.content });
          }
          content.push({ type: 'image_url', image_url: { url: m.image } });
          return { role, content };
        }
        return typeof m.content === 'string' && m.content.trim()
          ? { role, content: m.content }
          : null;
      }

      // 纯文本消息
      return typeof m.content === 'string' && m.content.trim()
        ? { role, content: m.content }
        : null;
    })
    .filter(Boolean);
}

// 统一的 JSON 解析助手：安全地从 response 中提取 JSON，兼容非 200 状态码和空 body
async function safeJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text || !text.trim()) {
    // 空 body：返回一个包含 status code 的错误对象
    return {
      status: response.ok ? 'success' : 'error',
      code: response.status,
      message: response.ok ? '' : `HTTP ${response.status} ${response.statusText || ''}`.trim(),
      data: null,
    };
  }
  try {
    return JSON.parse(text);
  } catch {
    // 非 JSON：包装为错误对象
    return {
      status: 'error',
      code: response.status,
      message: text.slice(0, 200),
      data: null,
    };
  }
}

export const api = {
  // 登录
  async login(credentials: any) {
    const response = await fetch(`${BASE_API_URL}/api/client-portal/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    return safeJson(response);
  },

  // 获取 API Keys（与 PC 端 Rust 后端一致：先 dashboard 后 tokens，用 x-session-token）
  async fetchApiKeys(sessionToken: string) {
    const urls = [
      `${BASE_API_URL}/api/client-portal/dashboard`,
      `${BASE_API_URL}/api/client-portal/tokens`,
    ];
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: { 'x-session-token': sessionToken, 'Authorization': sessionToken },
        });
        if (response.ok) {
          const data = await safeJson(response);
          // 兼容新旧格式：成功时才返回
          if (data?.status === 'success' || data?.code === 200 || data?.success === true) {
            return data;
          }
        }
      } catch { /* 尝试下一个 */ }
    }
    return {};
  },

  // 充值接口（x-session-token 认证）
  async recharge(sessionToken: string, voucherCode: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${BASE_API_URL}/api/client-portal/recharge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ voucher_code: voucherCode }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await safeJson(response);
      return data;
    } catch (e) {
      clearTimeout(timer);
      console.warn('=== recharge error ===', e);
      throw e;
    }
  },

  // 余额与账户信息刷新（GET /dashboard + x-session-token）
  async refreshAccount(sessionToken: string) {
    const response = await fetch(`${BASE_API_URL}/api/client-portal/dashboard`, {
      headers: { 'x-session-token': sessionToken },
    });
    return safeJson(response);
  },

  // 历史消息持久化（带会话索引）
  async saveHistory(sessionId: string, messages: any[]) {
    await AsyncStorage.setItem(`history_${sessionId}`, JSON.stringify(messages));
    const idxRaw = await AsyncStorage.getItem('sessions_index');
    let idx: any[] = safeParse(idxRaw, []);
    if (!Array.isArray(idx)) idx = [];
    idx = [{ id: sessionId, updatedAt: Date.now() }, ...idx.filter((s: any) => s.id !== sessionId)];
    await AsyncStorage.setItem('sessions_index', JSON.stringify(idx));
  },

  async loadHistory(sessionId: string) {
    const history = await AsyncStorage.getItem(`history_${sessionId}`);
    const parsed = safeParse(history, []);
    return Array.isArray(parsed) ? parsed : [];
  },

  async listSessions() {
    const idxRaw = await AsyncStorage.getItem('sessions_index');
    let idx: any[] = safeParse(idxRaw, []);
    if (!Array.isArray(idx)) idx = [];
    // 兼容：索引起步前，从 history_ 键恢复
    if (idx.length === 0) {
      const allKeys = await AsyncStorage.getAllKeys();
      idx = allKeys.filter(k => k.startsWith('history_')).map(k => ({ id: k.replace('history_', ''), updatedAt: 0 }));
    }
    const sessions = [];
    for (const item of idx) {
      let title = '对话 ' + item.id.slice(-4);
      try {
        const raw = await AsyncStorage.getItem(`history_${item.id}`);
        const msgs = raw ? JSON.parse(raw) : [];
        const firstUser = msgs.find((m: any) => m.role === 'user');
        if (firstUser?.content) title = String(firstUser.content).slice(0, 24);
      } catch { /* 保留默认标题 */ }
      sessions.push({ id: item.id, title, updatedAt: item.updatedAt });
    }
    return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  async deleteSession(sessionId: string) {
    await AsyncStorage.removeItem(`history_${sessionId}`);
    const idxRaw = await AsyncStorage.getItem('sessions_index');
    const parsed = safeParse(idxRaw, null);
    if (Array.isArray(parsed)) {
      const idx: any[] = parsed.filter((s: any) => s.id !== sessionId);
      await AsyncStorage.setItem('sessions_index', JSON.stringify(idx));
    }
  },

  // 当前会话 ID 持久化（重启 App 后恢复上次对话）
  async saveLastSession(sessionId: string) {
    await AsyncStorage.setItem('last_session_id', sessionId);
  },

  async loadLastSession(): Promise<string | null> {
    return AsyncStorage.getItem('last_session_id');
  },

  // 语音转文字（STT）
  async transcribeAudio(args: { endpoint: string; token: string; uri: string }): Promise<string> {
    const authHeader = args.token ? (args.token.startsWith('Bearer ') ? args.token : `Bearer ${args.token}`) : '';
    const base = normalizeEndpoint(args.endpoint);

    const response = await uploadAsync(
      `${base}/v1/audio/transcriptions`,
      args.uri,
      {
        headers: {
          'Authorization': authHeader,
        },
        httpMethod: 'POST',
        uploadType: FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        mimeType: 'audio/m4a',
        parameters: {
          model: 'whisper-1',
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(friendlyError(response.status, response.body));
    }

    try {
      const data = JSON.parse(response.body);
      return data.text || '';
    } catch {
      throw new Error('解析语音识别结果失败');
    }
  },

  // 配置存储
  async saveConfig(config: any) {
    await AsyncStorage.setItem('agent_config', JSON.stringify(config));
  },

  async loadConfig() {
    try {
      const raw = await AsyncStorage.getItem('agent_config');
      if (!raw) return null;
      const config = JSON.parse(raw);
      // 存量用户 endpoint 自动迁移：旧域名 frapi.kdns.fr → 新域名 gate.127110.xyz
      // 同时迁移 BASE_API_URL（门户 API）和 builtin_endpoint（OpenAI 兼容接口）
      let needsSave = false;
      const NEW_OFFICIAL = 'https://gate.127110.xyz';
      if (config.builtin_endpoint && config.builtin_endpoint.includes('frapi.kdns.fr')) {
        config.builtin_endpoint = NEW_OFFICIAL;
        needsSave = true;
      }
      // 兜底：即使没有旧域名，也强制确保 builtin_endpoint 等于官方新域名（防止用户手动改过导致不一致）
      if (!config.builtin_endpoint || config.builtin_endpoint !== NEW_OFFICIAL) {
        config.builtin_endpoint = NEW_OFFICIAL;
        needsSave = true;
      }
      if (needsSave) {
        await AsyncStorage.setItem('agent_config', JSON.stringify(config));
      }
      return config;
    } catch {
      await AsyncStorage.removeItem('agent_config');
      return null;
    }
  },

  async clearConfig() {
    await AsyncStorage.removeItem('agent_config');
  },

  // 用量统计独立存储：与账号配置解耦，退出登录/切换账号均不归零
  async loadUsageStats() {
    try {
      const raw = await AsyncStorage.getItem('local_usage_stats');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  async saveUsageStats(stats: any) {
    await AsyncStorage.setItem('local_usage_stats', JSON.stringify(stats));
  },

  async fetchModels(endpoint: string, apiKey?: string) {
    const base = normalizeEndpoint(endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
      const response = await fetch(`${base}/v1/models`, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  },

  async sendChatRequest(args: any) {
    const authHeader = args.token ? (args.token.startsWith('Bearer ') ? args.token : `Bearer ${args.token}`) : '';
    const base = normalizeEndpoint(args.endpoint);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model,
        messages: sanitizeMessages(JSON.parse(args.history || "[]")).concat([buildUserContent(args)]),
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(friendlyError(response.status, errText));
    }
    return response.json();
  },

  // 流式对话（SSE），onDelta 接收增量文本，onDone 接收最终 usage，signal 用于中断。
  // 上游临时繁忙（并发量较大/429/503）时自动静默重试，用户只看到「正在思考」，
  // 不会收到「并发量较大请 300 秒后重试」这类网关内部文案。
  async sendChatStream(args: any, onDelta: (text: string) => void, onDone: (usage: any) => void, signal?: AbortSignal) {
    const authHeader = args.token ? (args.token.startsWith('Bearer ') ? args.token : `Bearer ${args.token}`) : '';
    const base = normalizeEndpoint(args.endpoint);
    const body = JSON.stringify({
      model: args.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: sanitizeMessages(JSON.parse(args.history || "[]")).concat([buildUserContent(args)]),
    });

    const MAX_ATTEMPTS = 3;

    // 调试日志：仅首轮打印，验证多模态结构是否正确
    if (args.__debugLog !== false) {
      try {
        const parsed = JSON.parse(body);
        const lastUser = parsed.messages[parsed.messages.length - 1];
        const hasImageInLast = Array.isArray(lastUser?.content) && lastUser.content.some((p: any) => p.type === 'image_url');
        const imagePreview = hasImageInLast
          ? lastUser.content.find((p: any) => p.type === 'image_url')?.image_url?.url?.slice(0, 60) + '...'
          : '(none)';
        console.log('[ChatX] stream request:', JSON.stringify({
          model: args.model,
          totalMessages: parsed.messages.length,
          lastContentIsArray: Array.isArray(lastUser?.content),
          lastHasImage: hasImageInLast,
          imageUrlPrefix: imagePreview,
        }));
      } catch {}
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) return;
      let emitted = false;      // 是否已向 UI 输出任何增量
      let retryable = false;
      let lastError = '';

      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        signal,
        body,
      }).catch((e: any) => {
        // 网络层异常也归入可重试
        lastError = e?.message || '网络连接失败';
        retryable = true;
        return null as any;
      });

      if (!response) {
        if (attempt < MAX_ATTEMPTS && !signal?.aborted) {
          await delay(6000 * attempt);
          continue;
        }
        throw new Error(lastError || '网络连接失败');
      }

      if (!response.ok) {
        const errText = await response.text();
        const msg = friendlyError(response.status, errText);
        // 上游繁忙：静默重试，绝不把「并发量较大」抛给用户
        if (isTransientError(response.status, errText) && attempt < MAX_ATTEMPTS && !signal?.aborted) {
          await delay(6000 * attempt);
          continue;
        }
        throw new Error(msg);
      }

      // @ts-ignore
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let usage: any = null;
      let cancelled = false;

      const cancel = () => { cancelled = true; reader.cancel().catch(() => {}); };
      signal?.addEventListener('abort', cancel);

      // 空闲超时：60 秒无任何数据即视为上游卡死（图片对话首包更慢，放宽到 60s）
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(cancel, 60000);
      };
      resetIdle();

      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdle();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              // 流内错误：网关可能返回 200 但 data 中带 error
              if (json.error) {
                const emsg = json.error.message || 'AI 响应错误';
                // 尚未输出任何内容且属于繁忙类 → 静默重试
                if (!emitted && isTransientError(0, emsg) && attempt < MAX_ATTEMPTS) {
                  retryable = true;
                  lastError = emsg;
                  cancel();
                  break;
                }
                throw new Error(emsg);
              }
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) {
                // 首包内容若是网关繁忙文案（部分渠道把限流信息当正文流出来），
                // 视为可重试错误，不写入气泡，避免用户看到「并发量较大」
                if (!emitted && TRANSIENT_PATTERN.test(delta.content)) {
                  retryable = true;
                  lastError = delta.content.replace(/^\s*错误[：:]\s*/, '').trim();
                  cancel();
                  break;
                }
                emitted = true;
                onDelta(delta.content);
              }
              if (json.usage) usage = json.usage;
            } catch (e: any) {
              if (e?.message && !e.message.includes('Unexpected')) throw e;
            }
          }
          if (retryable) break;
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      if (retryable && attempt < MAX_ATTEMPTS && !signal?.aborted) {
        await delay(6000 * attempt);
        continue;
      }
      if (retryable) throw new Error(lastError || 'AI 响应繁忙，请稍后重试');

      if (signal?.aborted) return;
      onDone(usage || {});
      return;
    }
  },

  // 图片生成（OpenAI 兼容 /v1/images/generations）
  // 图片生成：网关不保证支持 /v1/images/generations，因此按「多通道 + 多模型」依次尝试：
  // 通道 A：/v1/chat/completions + 原生出图模型（gemini-3.1-flash-image 等）—— 网关声明支持的主力
  // 通道 B：/v1/images/generations + cogview-4（智谱）
  // 任一通道成功即返回，全部失败才报错。用户看到的只有「生成中」。
  async generateImage(args: any): Promise<{ urls: string[]; error?: string }> {
    const authHeader = args.token
      ? (args.token.startsWith('Bearer ') ? args.token : `Bearer ${args.token}`)
      : '';
    const base = normalizeEndpoint(args.endpoint || 'https://gate.127110.xyz');
    const quantity = Math.max(1, Math.min(4, Number(args.n) || 1));

    // 从任意响应对象中抽取图片：兼容 markdown / images[] / b64_json / data[]
    const extractUrls = (json: any): string[] => {
      const out: string[] = [];
      const push = (v: any) => { if (typeof v === 'string' && v) out.push(v); };

      // OpenAI images 格式
      for (const d of json?.data || []) {
        if (d?.url) push(d.url);
        else if (d?.b64_json) push(`data:image/png;base64,${d.b64_json}`);
      }

      for (const choice of json?.choices || []) {
        const msg = choice?.message;
        if (!msg) continue;
        // Gemini 风格 images 数组
        for (const img of msg.images || []) {
          push(img?.image_url?.url || img?.url);
          if (img?.b64_json) push(`data:image/png;base64,${img.b64_json}`);
        }
        // 多模态 content 数组
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            push(part?.image_url?.url || part?.url);
            if (part?.b64_json) push(`data:image/png;base64,${part.b64_json}`);
          }
        }
        // 文本里的 markdown 图片 / 内联 data URL
        if (typeof msg.content === 'string') {
          const md = msg.content.match(/!\[[^\]]*\]\(([^)]+)\)/g) || [];
          for (const m of md) {
            const u = m.match(/\(([^)]+)\)/)?.[1];
            if (u) push(u.trim());
          }
          const dataUrls = msg.content.match(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g) || [];
          for (const d of dataUrls) push(d);
        }
      }
      // 去重 + 只保留可用形态
      return Array.from(new Set(out)).filter(u => /^(https?:|data:image)/.test(u));
    };

    // 通道 A：原生出图模型走 chat/completions（逐个模型尝试）
    // 模型清单动态取自网关 /v1/models，避免硬编码失效；稳定版优先于 preview
    let chatModels: string[] = args.chatModels || [];
    if (chatModels.length === 0) {
      try {
        const r = await fetch(`${base}/v1/models`, { headers: authHeader ? { Authorization: authHeader } : {} });
        if (r.ok) {
          const json = await r.json();
          const ids: string[] = (json?.data || []).map((m: any) => m?.id).filter((id: any) => typeof id === 'string');
          const priority = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image'];
          const all = ids.filter(id => /image/i.test(id) && !/edit/i.test(id));
          chatModels = [
            ...priority.filter(p => all.includes(p)),
            ...all.filter(id => !priority.includes(id) && !/preview/i.test(id)),
            ...all.filter(id => !priority.includes(id) && /preview/i.test(id)),
          ];
        }
      } catch { /* 忽略，落到默认清单 */ }
    }
    if (chatModels.length === 0) {
      chatModels = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3-pro-image'];
    }
    let lastErr = '';
    for (const model of chatModels) {
      try {
        const response = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: args.prompt }],
            stream: false,
          }),
        });
        if (!response.ok) {
          const errText = await response.text();
          lastErr = friendlyError(response.status, errText);
          // 模型不存在/无权限 → 换下一个；繁忙 → 重试一次
          if (isTransientError(response.status, errText)) {
            await delay(4000);
            continue;
          }
          continue;
        }
        const json = await response.json();
        const urls = extractUrls(json);
        if (urls.length > 0) return { urls: urls.slice(0, quantity) };
        lastErr = '模型未返回图片';
      } catch (e: any) {
        lastErr = e?.message || '网络异常';
      }
    }

    // 通道 B：标准 images/generations（cogview 系列）
    const drawModels: string[] = args.drawModels || ['cogview-4', 'cogview-3-flash'];
    for (const model of drawModels) {
      try {
        const response = await fetch(`${base}/v1/images/generations`, {
          method: 'POST',
          headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: args.prompt,
            n: quantity,
            size: args.size || '1024x1024',
          }),
        });
        if (!response.ok) {
          const errText = await response.text();
          lastErr = friendlyError(response.status, errText);
          if (isTransientError(response.status, errText)) await delay(4000);
          continue;
        }
        const json = await response.json();
        const urls = extractUrls(json);
        if (urls.length > 0) return { urls: urls.slice(0, quantity) };
        lastErr = '模型未返回图片';
      } catch (e: any) {
        lastErr = e?.message || '网络异常';
      }
    }

    return { urls: [], error: lastErr || '当前渠道暂不支持图片生成' };
  },
};
