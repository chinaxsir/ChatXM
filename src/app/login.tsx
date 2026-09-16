import React, { useState } from 'react';
import { StyleSheet, View, TextInput, TouchableOpacity, SafeAreaView, ActivityIndicator } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';

export default function LoginScreen({ onLoginSuccess }: { onLoginSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    try {
      const res = await api.login({ username, password });
      console.log('=== 登录响应 ===', res);
      if (res?.status !== 'success') {
        alert('登录失败: ' + (res?.message || JSON.stringify(res).substring(0, 150)));
        return;
      }

      const d = res.data || {};
      // 步骤1: 优先从登录响应提取 API Key（与 PC 端逻辑一致）
      let apiKeys: string[] = [];
      if (Array.isArray(d.tokens)) {
        apiKeys = d.tokens.map((t: any) => t?.token_key).filter(Boolean);
      }
      // 步骤2: 兜底调用 tokens 接口，兼容多种字段名
      if (apiKeys.length === 0 && d.session_token) {
        try {
          const kRes = await api.fetchApiKeys(d.session_token);
          console.log('=== API Key 接口响应 ===', kRes);
          const tarr = kRes?.data?.tokens || kRes?.tokens || (Array.isArray(kRes) ? kRes : []);
          apiKeys = tarr
            .map((t: any) => (typeof t === 'string' ? t : t?.token_key || t?.key || t?.api_key || ''))
            .filter(Boolean);
        } catch (e) {
          console.warn('拉取 API Keys 失败:', e);
        }
      }

      const finalConfig = {
        session_token: d.session_token || '',
        username: d.username || username,
        balance: d.balance || 0,
        builtin_endpoint: 'https://api.frapi.kdns.fr',
        api_keys: apiKeys,
        primary_api_key: apiKeys[0] || '',
        current_model: 'frapi',
      };
      console.log('=== 最终保存的配置 ===', finalConfig);

      await api.saveConfig(finalConfig);
      if (apiKeys.length === 0) {
        alert('登录成功，但未获取到 API Key，请检查账号下的 Token 列表');
      }
      onLoginSuccess();
    } catch (e) {
      alert('登录异常: ' + e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <ThemedText type="title" style={styles.title}>Frapi AI</ThemedText>
        <TextInput style={styles.input} placeholder="用户名" value={username} onChangeText={setUsername} />
        <TextInput style={styles.input} placeholder="密码" value={password} onChangeText={setPassword} secureTextEntry />
        <TouchableOpacity style={styles.btn} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#FFF" /> : <ThemedText style={styles.btnText}>登录</ThemedText>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 20 },
  card: { padding: 20, borderRadius: 15, backgroundColor: '#FFF' },
  title: { textAlign: 'center', marginBottom: 20 },
  input: { borderWidth: 1, borderColor: '#DDD', borderRadius: 8, padding: 12, marginBottom: 15 },
  btn: { backgroundColor: '#007AFF', padding: 15, borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#FFF', fontWeight: '600' }
});
