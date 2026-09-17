import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, SafeAreaView, ActivityIndicator, Animated, Easing, Linking, KeyboardAvoidingView, Platform, ScrollView, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useThemeMode } from '@/hooks/useThemeMode';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';

const palettes = {
  light: {
    bgTop: '#F5F6F8', bgBottom: '#E8EDF3',
    card: '#FFFFFF', border: '#E5E5EA', inputBg: '#F5F6F8',
    inputText: '#000', sub: '#8E8E93', accent: '#007AFF', accentSoft: '#E8F1FF',
    ring: 'rgba(0,122,255,0.35)', eye: '#8E8E93',
  },
  dark: {
    bgTop: '#000000', bgBottom: '#0A0A12',
    card: '#1C1C1E', border: '#2C2C2E', inputBg: '#2C2C2E',
    inputText: '#FFF', sub: '#8E8E93', accent: '#0A84FF', accentSoft: '#1A3A5C',
    ring: 'rgba(10,132,255,0.4)', eye: '#8E8E93',
  },
};

export default function LoginScreen({ onLoginSuccess }: { onLoginSuccess?: () => void }) {
  const { scheme } = useThemeMode();
  const C = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);
  const router = useRouter();
  const finish = onLoginSuccess ?? (() => router.replace('/'));

  // AI 脉冲动画
  const pulse1 = useRef(new Animated.Value(0)).current;
  const pulse2 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, { toValue: 1, duration: 2200, delay, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    const l1 = loop(pulse1, 0);
    const l2 = loop(pulse2, 1100);
    l1.start(); l2.start();
    return () => { l1.stop(); l2.stop(); };
  }, [pulse1, pulse2]);

  const ringStyle = (val: Animated.Value) => ({
    transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }) }],
    opacity: val.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.5, 0.25, 0] }),
  });

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) { Alert.alert('Frapi AI', '请输入用户名和密码'); return; }
    setLoading(true);
    try {
      const res = await api.login({ username, password });
      if (res?.status !== 'success') {
        Alert.alert('Frapi AI', '登录失败: ' + (res?.message || JSON.stringify(res).substring(0, 150)));
        return;
      }

      const d = res.data || {};
      let apiKeys: string[] = [];
      let tokenMeta: any[] = [];
      if (Array.isArray(d.tokens)) {
        tokenMeta = d.tokens.filter((t: any) => t?.token_key);
        apiKeys = tokenMeta.map((t: any) => t.token_key);
      }
      if (apiKeys.length === 0 && d.session_token) {
        try {
          const kRes = await api.fetchApiKeys(d.session_token);
          const tarr = kRes?.data?.tokens || kRes?.tokens || (Array.isArray(kRes) ? kRes : []);
          tokenMeta = tarr.filter((t: any) => typeof t === 'string' || t?.token_key || t?.key || t?.api_key);
          apiKeys = tokenMeta
            .map((t: any) => (typeof t === 'string' ? t : t?.token_key || t?.key || t?.api_key || ''))
            .filter(Boolean);
        } catch { /* 静默失败 */ }
      }

      const finalConfig = {
        session_token: d.session_token || '',
        username: d.username || username,
        balance: d.balance || 0,
        builtin_endpoint: 'https://api.frapi.kdns.fr',
        api_keys: apiKeys,
        api_key_meta: tokenMeta,
        primary_api_key: apiKeys[0] || '',
        current_model: 'frapi',
      };

      await api.saveConfig(finalConfig);
      finish();
    } catch (e: any) {
      Alert.alert('Frapi AI', '登录异常: ' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <LinearGradient
      colors={[C.bgTop, C.bgBottom]}
      style={styles.gradient}
    >
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Logo + 品牌区 */}
            <View style={styles.brandBlock}>
              <View style={styles.logoWrap}>
                <Animated.View style={[styles.pulseRing, { backgroundColor: C.ring }, ringStyle(pulse1)]} />
                <Animated.View style={[styles.pulseRing, { backgroundColor: C.ring }, ringStyle(pulse2)]} />
                <View style={[styles.logoCore, { backgroundColor: C.accent }]}>
                  <Text style={styles.logoText}>AI</Text>
                </View>
              </View>
              <Text style={[styles.title, { color: C.inputText }]}>Frapi AI</Text>
              <Text style={[styles.subtitle, { color: C.sub }]}>智能对话 · 随时为你服务</Text>
            </View>

            {/* 表单区 */}
            <View style={styles.formBlock}>
              <View style={[styles.inputWrap, {
                borderColor: focusField === 'user' ? C.accent : C.border,
                borderWidth: focusField === 'user' ? 1.5 : 1,
                backgroundColor: C.inputBg,
              }]}>
                <TextInput
                  style={[styles.input, { color: C.inputText, flex: 1 }]}
                  placeholder="邮箱"
                  placeholderTextColor={C.sub}
                  value={username}
                  onChangeText={setUsername}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="emailAddress"
                  onFocus={() => setFocusField('user')}
                  onBlur={() => setFocusField(null)}
                />
              </View>
              <View style={[styles.inputWrap, {
                borderColor: focusField === 'pwd' ? C.accent : C.border,
                borderWidth: focusField === 'pwd' ? 1.5 : 1,
                backgroundColor: C.inputBg,
              }]}>
                <TextInput
                  style={[styles.input, { color: C.inputText, flex: 1 }]}
                  placeholder="密码"
                  placeholderTextColor={C.sub}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPwd}
                  onFocus={() => setFocusField('pwd')}
                  onBlur={() => setFocusField(null)}
                />
                <TouchableOpacity onPress={() => setShowPwd((v) => !v)} style={styles.eyeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Text style={{ color: C.eye, fontSize: 18 }}>{showPwd ? '🙈' : '👁️'}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.loginBtn, { backgroundColor: C.accent }]}
                onPress={handleLogin}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.loginBtnText}>登 录</Text>}
              </TouchableOpacity>

              {/* 分割线 */}
              <View style={styles.dividerRow}>
                <View style={[styles.divider, { backgroundColor: C.border }]} />
                <Text style={[styles.dividerText, { color: C.sub }]}>或</Text>
                <View style={[styles.divider, { backgroundColor: C.border }]} />
              </View>

              <TouchableOpacity
                style={styles.registerBtn}
                onPress={() => Linking.openURL('https://frapi.kdns.fr/register')}
                activeOpacity={0.7}
              >
                <Text style={{ color: C.accent, fontSize: 15, fontWeight: '500' }}>还没有账号？立即注册</Text>
              </TouchableOpacity>
            </View>

            {/* 底部版本/备案信息（商用标配） */}
            <View style={styles.footer}>
              <Text style={[styles.footerText, { color: C.sub }]}>v1.0.0 · © Frapi AI</Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  safe: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 50, paddingBottom: 32, justifyContent: 'space-between' },

  brandBlock: { alignItems: 'center', marginTop: 30, marginBottom: 36 },
  logoWrap: { width: 88, height: 88, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  pulseRing: { position: 'absolute', width: 72, height: 72, borderRadius: 36 },
  logoCore: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 6 },
  logoText: { color: '#FFF', fontSize: 24, fontWeight: '700', letterSpacing: 1 },
  title: { fontSize: 26, fontWeight: '700', marginBottom: 4, letterSpacing: 0.5 },
  subtitle: { fontSize: 13 },

  formBlock: { width: '100%', gap: 14 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 12, paddingHorizontal: 14, height: 48,
  },
  input: { fontSize: 15, height: '100%' },
  eyeBtn: { padding: 6 },

  loginBtn: {
    borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center',
    marginTop: 4, elevation: 3, shadowColor: '#007AFF', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 6,
  },
  loginBtnText: { color: '#FFF', fontWeight: '600', fontSize: 16, letterSpacing: 2 },

  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 8 },
  divider: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: 12 },

  registerBtn: { alignItems: 'center', paddingVertical: 8 },

  footer: { alignItems: 'center', marginTop: 32 },
  footerText: { fontSize: 12 },
});
