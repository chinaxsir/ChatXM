import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_API_URL = "https://api.frapi.kdns.fr";

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
    const response = await fetch(`${BASE_API_URL}/api/client-portal/recharge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({ voucher_code: voucherCode }),
    });
    return response.json();
  },

  // 余额与账户信息刷新（GET /dashboard + x-session-token）
  async refreshAccount(sessionToken: string) {
    const response = await fetch(`${BASE_API_URL}/api/client-portal/dashboard`, {
      headers: { 'x-session-token': sessionToken },
    });
    return response.json();
  },

  // 历史消息持久化
  async saveHistory(sessionId: string, messages: any[]) {
    await AsyncStorage.setItem(`history_${sessionId}`, JSON.stringify(messages));
  },

  async loadHistory(sessionId: string) {
    const history = await AsyncStorage.getItem(`history_${sessionId}`);
    return history ? JSON.parse(history) : [];
  },

  async listSessions() {
    const allKeys = await AsyncStorage.getAllKeys();
    const sessions = allKeys.filter(key => key.startsWith('history_'));
    return sessions.map(key => ({ id: key.replace('history_', ''), title: '对话 ' + key.slice(-4) }));
  },

  async deleteSession(sessionId: string) {
    await AsyncStorage.removeItem(`history_${sessionId}`);
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
    const response = await fetch(`${endpoint}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return response.json();
  },

  async sendChatRequest(args: any) {
    const authHeader = args.token ? (args.token.startsWith('Bearer ') ? args.token : `Bearer ${args.token}`) : '';
    const response = await fetch(`${args.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model,
        messages: JSON.parse(args.history || "[]").concat([{ role: "user", content: args.prompt }])
      }),
    });
    return response.json();
  }
};
