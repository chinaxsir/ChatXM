import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, SafeAreaView, ActivityIndicator, Animated, Easing, Linking, KeyboardAvoidingView, Platform, ScrollView, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useThemeMode } from '@/hooks/useThemeMode';
import { ThemedText } from '@/components/themed-text';
import { LegalSheet } from '@/components/legal-sheet';
import { AppPalette } from '@/constants/design';
import { APP_NAME, APP_VERSION, LOGIN_URL, REGISTER_URL, LegalKind } from '@/constants/brand';
import { api } from '@/services/api';

const palettes = {
  light: {
    ...AppPalette.light,
    bgTop: '#F8FAFF', bgBottom: '#EDF2FA',
    inputBg: '#F5F6F8', inputText: AppPalette.light.text,
    ring: 'rgba(0,122,255,0.35)', eye: '#8E8E93',
    cardShadow: 'rgba(0,0,0,0.06)', cardBorder: 'rgba(0,0,0,0.04)',
    logoText1: '#FFFFFF', logoText2: '#FFFFFF',
    formCardBg: '#FFFFFF',
  },
  dark: {
    ...AppPalette.dark,
    bgTop: '#050510', bgBottom: '#0A0A1A',
    inputText: AppPalette.dark.text,
    ring: 'rgba(10,132,255,0.4)', eye: '#8E8E93',
    cardShadow: 'rgba(0,0,0,0.4)', cardBorder: 'rgba(255,255,255,0.06)',
    logoText1: '#FFFFFF', logoText2: '#FFFFFF',
    formCardBg: '#1C1C1E',
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
  // 商业合规：必须主动勾选协议才能登录，默认不勾选
  const [agreed, setAgreed] = useState(false);
  const [legalKind, setLegalKind] = useState<LegalKind | null>(null);
  const router = useRouter();
  const finish = onLoginSuccess ?? (() => router.replace('/'));

  // 品牌 Logo 脉冲动画（三层光环递进）
  const pulse1 = useRef(new Animated.Value(0)).current;
  const pulse2 = useRef(new Animated.Value(0)).current;
  const pulse3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, { toValue: 1, duration: 2400, delay, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    const l1 = loop(pulse1, 0);
    const l2 = loop(pulse2, 800);
    const l3 = loop(pulse3, 1600);
    l1.start(); l2.start(); l3.start();
    return () => { l1.stop(); l2.stop(); l3.stop(); };
  }, [pulse1, pulse2, pulse3]);

  const ringStyle = (val: Animated.Value, scaleOut: number = 2.2) => ({
    transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, scaleOut] }) }],
    opacity: val.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.6, 0.2, 0] }),
  });

  // 输入框 focus 阴影动画
  const focusScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (focusField) {
      Animated.spring(focusScale, { toValue: 1.01, useNativeDriver: true, friction: 6 }).start();
    } else {
      Animated.spring(focusScale, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
    }
  }, [focusField, focusScale]);

  // LegalSheet 需要的中性色板映射
  const legalColors = {
    bg: C.card, panel: C.card, border: C.border, sub: C.sub,
    text: C.inputText, accent: C.accent, mask: 'rgba(0,0,0,0.45)',
  };

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) { Alert.alert(APP_NAME, '请输入邮箱和密码'); return; }
    if (!agreed) { Alert.alert(APP_NAME, '请先阅读并同意《用户服务协议》和《隐私政策》'); return; }
    setLoading(true);
    try {
      const res = await api.login({ username, password });
      const isSuccess = res?.status === 'success' || res?.code === 200 || res?.success === true || res?.status === 'ok';
      if (!isSuccess) {
        const errMsg = res?.message || res?.data?.message || res?.error?.message || JSON.stringify(res).slice(0, 150);
        Alert.alert(APP_NAME, '登录失败: ' + errMsg);
        return;
      }

      const d = res.data || {};
      let apiKeys: string[] = [];
      let tokenMeta: any[] = [];

      const sessionToken = d.session_token || d.access_token || d.token || d.accessToken || '';

      const rawTokens = d.tokens || d.api_keys || d.keys || [];
      if (Array.isArray(rawTokens)) {
        tokenMeta = rawTokens.filter((t: any) => t?.token_key || t?.key || t?.api_key || t?.apiKey || typeof t === 'string');
        apiKeys = tokenMeta.map((t: any) => (typeof t === 'string' ? t : t?.token_key || t?.key || t?.api_key || t?.apiKey || '')).filter(Boolean);
      }

      if (apiKeys.length === 0 && sessionToken) {
        try {
          const kRes = await api.fetchApiKeys(sessionToken);
          const tarr = kRes?.data?.tokens || kRes?.data?.keys || kRes?.tokens || kRes?.keys || [];
          if (Array.isArray(tarr)) {
            tokenMeta = tarr.filter((t: any) => t?.token_key || t?.key || t?.api_key || typeof t === 'string');
            apiKeys = tokenMeta.map((t: any) => (typeof t === 'string' ? t : t?.token_key || t?.key || t?.api_key || '')).filter(Boolean);
          }
        } catch { /* 静默失败 */ }
      }

      const finalConfig = {
        session_token: sessionToken,
        username: d.username || d.user?.username || username,
        balance: d.balance ?? d.user?.balance ?? 0,
        builtin_endpoint: 'https://gate.127110.xyz',
        api_keys: apiKeys,
        api_key_meta: tokenMeta,
        primary_api_key: apiKeys[0] || '',
        current_model: 'frapi',
      };

      await api.saveConfig(finalConfig);
      finish();
    } catch (e: any) {
      Alert.alert(APP_NAME, '登录异常: ' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const inputField = (
    field: 'user' | 'pwd',
    placeholder: string,
    icon: string,
    secure: boolean = false,
  ) => {
    const focused = focusField === field;
    return (
      <View
        style={[
          styles.inputWrap,
          {
            borderColor: focused ? C.accent : C.border,
            borderWidth: focused ? 1.5 : 1,
            backgroundColor: C.inputBg,
            shadowOpacity: focused ? 0.12 : 0,
            shadowRadius: focused ? 8 : 0,
            shadowColor: C.accent,
            shadowOffset: { width: 0, height: 0 },
            elevation: focused ? 2 : 0,
          },
        ]}
      >
        <Text style={[styles.inputIcon, { color: C.sub }]}>{icon}</Text>
        <TextInput
          style={[styles.input, { color: C.inputText, flex: 1 }]}
          placeholder={placeholder}
          placeholderTextColor={C.sub}
          value={field === 'user' ? username : password}
          onChangeText={field === 'user' ? setUsername : setPassword}
          secureTextEntry={secure ? !showPwd : false}
          keyboardType={field === 'user' ? 'email-address' : 'default'}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType={field === 'user' ? 'emailAddress' : 'password'}
          onFocus={() => setFocusField(field)}
          onBlur={() => setFocusField(null)}
        />
        {secure && (
          <TouchableOpacity onPress={() => setShowPwd((v) => !v)} style={styles.eyeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={{ color: C.eye, fontSize: 18 }}>{showPwd ? '🙈' : '👁️'}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
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
                <Animated.View style={[styles.pulseRing, { backgroundColor: C.ring }, ringStyle(pulse1, 2.4)]} />
                <Animated.View style={[styles.pulseRing, { backgroundColor: C.ring }, ringStyle(pulse2, 2.0)]} />
                <Animated.View style={[styles.pulseRing, { backgroundColor: C.ring }, ringStyle(pulse3, 1.7)]} />
                <LinearGradient
                  colors={scheme === 'dark' ? ['#0A84FF', '#0066CC'] : ['#007AFF', '#0062D6']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[styles.logoCore, {
                    shadowColor: C.accent,
                    shadowOpacity: 0.35,
                    shadowRadius: 16,
                    shadowOffset: { width: 0, height: 4 },
                    elevation: 6,
                  }]}
                >
                  <Text style={styles.logoText}>CX</Text>
                </LinearGradient>
              </View>
              <Text style={[styles.title, { color: C.inputText }]}>Chat X</Text>
              <Text style={[styles.subtitle, { color: C.sub }]}>智能对话 · 随时为你服务</Text>
            </View>

            {/* 表单卡片 */}
            <Animated.View
              style={[
                styles.formCard,
                {
                  backgroundColor: C.formCardBg,
                  borderColor: C.cardBorder,
                  shadowColor: C.cardShadow,
                  transform: [{ scale: focusScale }],
                },
              ]}
            >
              <View style={styles.formCardHeader}>
                <ThemedText type="subtitle" style={styles.formCardTitle}>欢迎回来</ThemedText>
                <Text style={[styles.formCardSub, { color: C.sub }]}>请登录你的账号继续使用</Text>
              </View>

              <View style={styles.formBlock}>
                {inputField('user', '邮箱地址', '📧')}
                {inputField('pwd', '登录密码', '🔒', true)}

                <TouchableOpacity
                  onPress={() => Linking.openURL(LOGIN_URL)}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  style={styles.forgotRow}
                >
                  <Text style={[styles.forgotText, { color: C.sub }]}>忘记密码？</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.consentRow}
                  onPress={() => setAgreed((v) => !v)}
                  activeOpacity={0.7}
                  hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
                >
                  <View style={[
                    styles.checkbox,
                    { borderColor: agreed ? C.accent : C.border, backgroundColor: agreed ? C.accent : 'transparent' },
                  ]}>
                    {agreed && <Text style={styles.checkMark}>✓</Text>}
                  </View>
                  <Text style={[styles.consentText, { color: C.sub }]}>
                    我已阅读并同意
                    <Text style={{ color: C.accent }} onPress={() => setLegalKind('terms')}>《用户服务协议》</Text>
                    与
                    <Text style={{ color: C.accent }} onPress={() => setLegalKind('privacy')}>《隐私政策》</Text>
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.loginBtn,
                    {
                      shadowColor: C.accent,
                      shadowOpacity: 0.35,
                      shadowRadius: 12,
                      shadowOffset: { width: 0, height: 4 },
                      elevation: 5,
                      opacity: loading ? 0.7 : 1,
                    },
                  ]}
                  onPress={handleLogin}
                  disabled={loading}
                  activeOpacity={0.85}
                >
                  <LinearGradient
                    colors={scheme === 'dark' ? ['#0A84FF', '#0066CC'] : ['#007AFF', '#0062D6']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.loginBtnInner}
                  >
                    {loading ? (
                      <ActivityIndicator color="#FFF" />
                    ) : (
                      <Text style={styles.loginBtnText}>登 录</Text>
                    )}
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </Animated.View>

            {/* 注册入口 */}
            <View style={styles.registerRow}>
              <Text style={[styles.registerText, { color: C.sub }]}>还没有账号？</Text>
              <TouchableOpacity
                onPress={() => Linking.openURL(REGISTER_URL)}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              >
                <Text style={[styles.registerLink, { color: C.accent }]}>立即注册 →</Text>
              </TouchableOpacity>
            </View>

            {/* 底部品牌信息 */}
            <View style={styles.footer}>
              <Text style={[styles.footerText, { color: C.sub }]}>v{APP_VERSION} · © {APP_NAME}</Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      <LegalSheet
        kind={legalKind}
        visible={legalKind !== null}
        onClose={() => setLegalKind(null)}
        colors={legalColors}
      />
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  safe: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 16, alignItems: 'stretch' },

  // ===== 品牌 Logo 区 =====
  brandBlock: { alignItems: 'center', marginTop: 4, marginBottom: 20 },
  logoWrap: { width: 100, height: 100, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  pulseRing: { position: 'absolute', width: 84, height: 84, borderRadius: 42 },
  logoCore: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center',
  },
  logoText: { color: '#FFF', fontSize: 28, fontWeight: '800', letterSpacing: 2 },
  title: { fontSize: 28, fontWeight: '800', marginBottom: 6, letterSpacing: 0.8 },
  subtitle: { fontSize: 13, fontWeight: '500' },

  // ===== 表单卡片 =====
  formCard: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    paddingTop: 18,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 20,
    elevation: 4,
  },
  formCardHeader: { marginBottom: 16 },
  formCardTitle: { fontSize: 18, fontWeight: '700' },
  formCardSub: { fontSize: 12, marginTop: 3 },

  // ===== 输入字段 =====
  formBlock: { width: '100%', gap: 12 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 12, paddingHorizontal: 12, height: 50,
  },
  inputIcon: { fontSize: 17, marginRight: 8 },
  input: { fontSize: 15, height: '100%' },
  eyeBtn: { padding: 6 },

  // ===== 忘记密码 / 协议勾选 =====
  forgotRow: { alignSelf: 'flex-end', marginTop: -6 },
  forgotText: { fontSize: 12.5 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 2 },
  checkbox: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 1.2,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  checkMark: { color: '#FFF', fontSize: 11, fontWeight: '700', lineHeight: 13 },
  consentText: { flex: 1, fontSize: 11.5, lineHeight: 17 },

  // ===== 登录按钮 =====
  loginBtn: {
    borderRadius: 14, height: 50, marginTop: 4, overflow: 'hidden',
  },
  loginBtnInner: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
  },
  loginBtnText: { color: '#FFF', fontWeight: '700', fontSize: 16, letterSpacing: 3 },

  // ===== 注册入口 =====
  registerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 14, paddingVertical: 6, gap: 4,
  },
  registerText: { fontSize: 13 },
  registerLink: { fontSize: 14, fontWeight: '600' },

  // ===== 底部信息 =====
  footer: { alignItems: 'center', marginTop: 'auto', paddingTop: 16 },
  footerText: { fontSize: 12 },
});
