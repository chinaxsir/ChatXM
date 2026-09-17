import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, SafeAreaView, ActivityIndicator, Animated, Easing, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeMode } from '@/hooks/useThemeMode';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';

const palettes = {
  light: { bg: '#F5F6F8', card: '#FFFFFF', border: '#E5E5EA', inputText: '#000', sub: '#8E8E93', accent: '#007AFF', accentSoft: '#E8F1FF', ring: 'rgba(0,122,255,0.35)' },
  dark: { bg: '#000000', card: '#1C1C1E', border: '#3A3A3C', inputText: '#FFF', sub: '#8E8E93', accent: '#0A84FF', accentSoft: '#1A3A5C', ring: 'rgba(10,132,255,0.4)' },
};

export default function LoginScreen({ onLoginSuccess }: { onLoginSuccess?: () => void }) {
  const { scheme } = useThemeMode();
  const C = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const finish = onLoginSuccess ?? (() => router.replace('/'));

  // AI 脉冲动画：两层光环交替扩散
  const pulse1 = useRef(new Animated.Value(0)).current;
  const pulse2 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, { toValue: 1, duration: 2000, delay, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    const l1 = loop(pulse1, 0);
    const l2 = loop(pulse2, 1000);
    l1.start();
    l2.start();
    return () => { l1.stop(); l2.stop(); };
  }, [pulse1, pulse2]);

  const ringStyle = (val: Animated.Value) => ({
    transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
    opacity: val.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.45, 0.25, 0] }),
  });

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
      let apiKeys: string[] = [];
      if (Array.isArray(d.tokens)) {
        apiKeys = d.tokens.map((t: any) => t?.token_key).filter(Boolean);
      }
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
      finish();
    } catch (e) {
      alert('登录异常: ' + e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: C.bg }]}>
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.border, borderWidth: 1 }]}>
        {/* AI 脉冲 Logo */}
        <View style={styles.logoWrap}>
          <Animated.View style={[styles.pulseRing, { backgroundColor: C.ring }, ringStyle(pulse1)]} />
          <Animated.View style={[styles.pulseRing, { backgroundColor: C.ring }, ringStyle(pulse2)]} />
          <View style={[styles.logoCore, { backgroundColor: C.accent }]}>
            <Text style={styles.logoText}>AI</Text>
          </View>
        </View>

        <ThemedText type="title" style={styles.title}>Frapi AI</ThemedText>
        <ThemedText style={[styles.subtitle, { color: C.sub }]}>智能对话 · 随时为你服务</ThemedText>

        <TextInput
          style={[styles.input, { borderColor: C.border, color: C.inputText, backgroundColor: C.bg }]}
          placeholder="用户名"
          placeholderTextColor={C.sub}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
        />
        <TextInput
          style={[styles.input, { borderColor: C.border, color: C.inputText, backgroundColor: C.bg }]}
          placeholder="密码"
          placeholderTextColor={C.sub}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        <TouchableOpacity style={[styles.btn, { backgroundColor: C.accent }]} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#FFF" /> : <ThemedText style={styles.btnText}>登录</ThemedText>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.registerLink} onPress={() => Linking.openURL('https://frapi.kdns.fr/register')}>
          <ThemedText style={{ color: C.accent, fontSize: 14 }}>没有账号？立即注册</ThemedText>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { padding: 24, borderRadius: 20 },
  logoWrap: { width: 100, height: 100, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 20 },
  pulseRing: { position: 'absolute', width: 80, height: 80, borderRadius: 40 },
  logoCore: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#FFF', fontSize: 28, fontWeight: '700', letterSpacing: 1 },
  title: { textAlign: 'center', marginBottom: 4 },
  subtitle: { textAlign: 'center', fontSize: 13, marginBottom: 24 },
  input: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 14, fontSize: 15 },
  btn: { padding: 15, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  btnText: { color: '#FFF', fontWeight: '600', fontSize: 16 },
  registerLink: { alignItems: 'center', marginTop: 16 },
});
