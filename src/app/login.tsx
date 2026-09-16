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
      if (res.status === 'success') {
        const userData = res.data;
        let apiKeys: string[] = [];
        
        try {
          const tokenRes = await api.fetchApiKeys(userData.session_token);
          apiKeys = tokenRes.data?.tokens?.map((t: any) => t.token_key) || [];
        } catch (e) {
          console.warn("拉取 API Keys 失败:", e);
        }

        const finalConfig = {
          ...userData,
          username,
          api_keys: apiKeys,
          primary_api_key: apiKeys[0] || userData.primary_api_key || "",
          builtin_endpoint: "https://api.frapi.kdns.fr"
        };
        
        await api.saveConfig(finalConfig);
        onLoginSuccess();
      } else {
        alert('登录失败: ' + res.message);
      }
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
