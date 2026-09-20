import AsyncStorage from '@react-native-async-storage/async-storage';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';

const BASE_API_URL = "https://api.frapi.kdns.fr";

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
  401: 'API Key 无效或已过期，请检查后重试',
  403: '无权限访问该接口',
  404: '接口地址不存在，请检查 Endpoint 配置是否正确',
  408: '请求超时，请检查网络后重试',
  429: '请求过于频繁，请稍后重试',
  500: '服务器内部错误',
  502: '网关错误',
  503: '服务暂不可用',
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
// 剥离 displayContent/image/fileName/audio 等 UI 字段与空消息，避免接口 400
function sanitizeMessages(raw: any[]): any[] {
  return (Array.isArray(raw) ? raw : [])
    .map((m: any) => {
      if (!m) return null;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (typeof m.content === 'string' && m.content.trim()) {
        return { role, content: m.content };
      }
      if (Array.isArray(m.content) && m.content.length > 0) {
        return { role, content: m.content };
      }
      return null;
    })
    .filter(Boolean);
}

export const api = {
  // 登录
  async login(credentials: any) {
    const response = await fetch(`${BASE_API_URL}/api/client-portal/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    return response.json();
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
        if (response.ok) return response.json();
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
      const text = await response.text();
      clearTimeout(timer);
      console.log('=== recharge response raw ===', text?.substring(0, 200));
      try { return JSON.parse(text); } catch { return { status: 'error', message: text || `HTTP ${response.status}` }; }
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
    return response.json();
  },

  // 历史消息持久化（带会话索引）
  async saveHistory(sessionId: string, messages: any[]) {
    await AsyncStorage.setItem(`history_${sessionId}`, JSON.stringify(messages));
    const idxRaw = await AsyncStorage.getItem('sessions_index');
    let idx: any[] = idxRaw ? JSON.parse(idxRaw) : [];
    idx = [{ id: sessionId, updatedAt: Date.now() }, ...idx.filter((s: any) => s.id !== sessionId)];
    await AsyncStorage.setItem('sessions_index', JSON.stringify(idx));
  },

  async loadHistory(sessionId: string) {
    const history = await AsyncStorage.getItem(`history_${sessionId}`);
    return history ? JSON.parse(history) : [];
  },

  async listSessions() {
    const idxRaw = await AsyncStorage.getItem('sessions_index');
    let idx: any[] = idxRaw ? JSON.parse(idxRaw) : [];
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
    if (idxRaw) {
      const idx: any[] = JSON.parse(idxRaw).filter((s: any) => s.id !== sessionId);
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
    const config = await AsyncStorage.getItem('agent_config');
    return config ? JSON.parse(config) : null;
  },

  async clearConfig() {
    await AsyncStorage.removeItem('agent_config');
  },

  async fetchModels(endpoint: string, apiKey: string) {
    const base = normalizeEndpoint(endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${base}/v1/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: controller.signal,
      });
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

  // 流式对话（SSE），onDelta 接收增量文本，onDone 接收最终 usage，signal 用于中断
  async sendChatStream(args: any, onDelta: (text: string) => void, onDone: (usage: any) => void, signal?: AbortSignal) {
    const authHeader = args.token ? (args.token.startsWith('Bearer ') ? args.token : `Bearer ${args.token}`) : '';
    const base = normalizeEndpoint(args.endpoint);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model: args.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: sanitizeMessages(JSON.parse(args.history || "[]")).concat([buildUserContent(args)]),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(friendlyError(response.status, errText));
    }

    // @ts-ignore
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: any = null;
    let aborted = false;
    signal?.addEventListener('abort', () => { aborted = true; reader.cancel().catch(() => {}); });

    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
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
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) onDelta(delta.content);
          if (json.usage) usage = json.usage;
        } catch { /* 忽略非 JSON 行 */ }
      }
    }
    if (!aborted) onDone(usage || {});
  }
};
