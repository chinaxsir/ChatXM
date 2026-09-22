import React, { useState, useCallback, useMemo } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ScrollView, Modal, Alert, Platform, SafeAreaView, Dimensions, Linking, ActivityIndicator } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter, useFocusEffect } from 'expo-router';
import { useThemeMode, ThemeMode } from '@/hooks/useThemeMode';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';

// 和 api.ts 中 normalizeEndpoint 保持一致的前端版本，用于输入时即时预览
function previewNormalize(url: string): string {
  if (!url) return '';
  let base = url.trim().replace(/\/+$/, '');
  const idx = base.toLowerCase().indexOf('/v1');
  if (idx > -1) base = base.substring(0, idx);
  return base.replace(/\/+$/,'');
}

// 脱敏用户名/邮箱，避免在界面上显示完整账号信息
function maskUsername(raw: string): string {
  if (!raw) return '已登录用户';
  const s = raw.trim();
  // 邮箱格式：y***x@gmail.com
  const atIdx = s.indexOf('@');
  if (atIdx > 0) {
    const local = s.substring(0, atIdx);
    const domain = s.substring(atIdx);
    if (local.length <= 1) return '*' + domain;
    if (local.length === 2) return local[0] + '*' + domain;
    return local[0] + '***' + local[local.length - 1] + domain;
  }
  // 普通用户名：保留首尾，中间 ***
  if (s.length <= 2) return '*'.repeat(s.length);
  if (s.length === 3) return s[0] + '*' + s[2];
  return s[0] + '***' + s[s.length - 1];
}

// API Key 脱敏：仅保留前6后4，中间用圆点代替，用于界面提示而非明文回显
function maskApiKey(k: string): string {
  if (!k) return '';
  if (k.length <= 10) return '••••••••';
  return `${k.slice(0, 6)}••••••••${k.slice(-4)}`;
}

const palettes = {
  light: { bg: '#F5F6F8', card: '#FFFFFF', border: '#E5E5EA', sub: '#8E8E93', inputBg: '#F5F6F8', accent: '#007AFF', accentSoft: '#E8F1FF', danger: '#E53E3E', mask: 'rgba(0,0,0,0.4)', panel: '#FFFFFF', cancelBg: '#F0F0F0', cancelText: '#333333', btnBg: '#F0F2F5', btnText: '#333333' },
  dark: { bg: '#000000', card: '#1C1C1E', border: '#2C2C2E', sub: '#8E8E93', inputBg: '#2C2C2E', accent: '#0A84FF', accentSoft: '#1A3A5C', danger: '#FF6B6B', mask: 'rgba(0,0,0,0.6)', panel: '#1C1C1E', cancelBg: '#2C2C2E', cancelText: '#E5E5EA', btnBg: '#2C2C2E', btnText: '#E5E5EA' },
};

export default function SettingsScreen() {
  const { mode, scheme, setMode } = useThemeMode();
  const C = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const screenWidth = Dimensions.get('window').width;
  const isNarrow = screenWidth < 400;
  const [config, setConfig] = useState<any>(null);
  const [showRecharge, setShowRecharge] = useState(false);
  const [showAddApi, setShowAddApi] = useState(false);
  // null = 新增模式；数字 = 正在编辑的第三方 API 索引
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [voucher, setVoucher] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiForm, setApiForm] = useState({ name: '', endpoint: '', apiKey: '', models: '' });
  const [showKey, setShowKey] = useState(false);
  const [testingApi, setTestingApi] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [testModels, setTestModels] = useState<string[]>([]);
  const router = useRouter();

  // 即时预览清洗后的 endpoint
  const cleanedEndpoint = useMemo(() => previewNormalize(apiForm.endpoint), [apiForm.endpoint]);
  const endpointWasCleaned = useMemo(() => apiForm.endpoint.trim() !== '' && cleanedEndpoint !== apiForm.endpoint.trim(), [apiForm.endpoint, cleanedEndpoint]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const c0 = await api.loadConfig();
        // 用量统计独立存储，水合回 config 展示（退出/切换账号不归零）
        const stats = await api.loadUsageStats();
        const c = stats && c0 ? { ...c0, usage: stats } : c0;
        if (stats && c0 && JSON.stringify(c0.usage) !== JSON.stringify(stats)) {
          await api.saveConfig(c);
        }
        if (!active) return;
        setConfig(c);
        if (c?.session_token) {
          try {
            const r = await api.refreshAccount(c.session_token);
            if (!active || !r) return;
            const d = r?.data ?? r;
            const balance = d?.balance ?? d?.user?.balance;
            // 同步后台最新 API Keys（用户可能在网页端增删过 key）
            const tokens = d?.tokens;
            let updated = { ...c };
            if (balance != null) updated.balance = balance;
            if (Array.isArray(tokens)) {
              const keys = tokens.map((t: any) => t?.token_key).filter(Boolean);
              if (keys.length) {
                updated.api_keys = keys;
                // 保存 key 元数据（名称/额度），用于设置页展示
                updated.api_key_meta = tokens.filter((t: any) => t?.token_key);
                // 当前 primary 已被删除时，自动回退到第一个 key（修复 unauthorized）
                if (!keys.includes(updated.primary_api_key)) {
                  updated.primary_api_key = keys[0];
                }
              }
            }
            await api.saveConfig(updated);
            setConfig(updated);
          } catch { /* 静默失败，保留本地数据 */ }
        }
      })();
      return () => { active = false; };
    }, [])
  );

  // 编辑模式下，Key 输入框留空表示沿用原密钥；此值返回实际用于请求/测试的 Key
  // 注意：此 Hook 必须在任何提前 return 之前调用，保证每次渲染 Hook 数量一致
  const getEffectiveApiKey = useCallback((): string => {
    const typed = apiForm.apiKey.trim();
    if (typed) return typed;
    if (editingIdx != null) return config?.third_party_apis?.[editingIdx]?.apiKey || '';
    return '';
  }, [apiForm.apiKey, editingIdx, config]);

  const today = new Date().toISOString().slice(0, 10);
  const todayUsage = config?.usage?.daily?.[today];

  if (!config?.session_token) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: C.bg }]}>
        <ThemedText>尚未登录</ThemedText>
        <TouchableOpacity style={[styles.btn, { backgroundColor: C.accent }]} onPress={() => router.push('/login')}>
          <ThemedText style={styles.btnText}>去登录</ThemedText>
        </TouchableOpacity>
      </View>
    );
  }

  // 切换当前对话使用的官方 API Key（所有 key 共用同一个 frapi 智能模型池）
  const switchPrimaryKey = async (key: string) => {
    if (!config || key === config.primary_api_key) return;
    const updated = { ...config, primary_api_key: key };
    await api.saveConfig(updated);
    setConfig(updated);
  };

  const doLogout = async () => {
    await api.clearConfig();
    router.replace('/');
  };

  const handleLogout = () => {
    if (Platform.OS === 'web') {
      if (window.confirm('确定要退出当前账号吗？')) doLogout();
    } else {
      Alert.alert('退出登录', '确定要退出当前账号吗？', [
        { text: '取消', style: 'cancel' },
        { text: '确定', style: 'destructive', onPress: doLogout },
      ]);
    }
  };

  const handleRecharge = async () => {
    if (!voucher.trim()) { Alert.alert('Frapi AI', '请输入卡密'); return; }
    setBusy(true);
    try {
      const res = await api.recharge(config.session_token, voucher.trim());
      console.log('=== recharge parsed ===', res);
      // 兼容后端多种成功返回格式
      const ok = res?.status === 'success' || res?.code === 'success' || res?.code === 200 || res?.ok === true;
      if (ok) {
        Alert.alert('Frapi AI', '充值成功' + (res?.data?.amount != null ? `，到账 ${res.data.amount}` : ''));
        setVoucher('');
        setShowRecharge(false);
        const updated = { ...config, balance: res?.data?.balance ?? config.balance };
        await api.saveConfig(updated);
        setConfig(updated);
      } else {
        // 兼容后端 {code, message} 格式
        const msg = res?.message || res?.error?.message || res?.data?.message || JSON.stringify(res).substring(0, 80);
        Alert.alert('Frapi AI', '充值失败: ' + msg);
      }
    } catch (e: any) {
      Alert.alert('Frapi AI', '充值失败: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // 打开「新增 API」弹窗：清空表单
  const openAddApiModal = () => {
    setEditingIdx(null);
    setApiForm({ name: '', endpoint: '', apiKey: '', models: '' });
    setShowKey(false);
    setTestingApi('idle');
    setTestMsg('');
    setTestModels([]);
    setShowAddApi(true);
  };

  // 打开「编辑 API」弹窗：回填名称/地址/模型，但 API Key 不回显明文（留空表示不修改）
  const openEditApiModal = (idx: number) => {
    const tp = config?.third_party_apis?.[idx];
    if (!tp) return;
    setEditingIdx(idx);
    setApiForm({
      name: tp.name || '',
      endpoint: tp.endpoint || '',
      apiKey: '',
      models: (tp.models || []).join(', '),
    });
    setShowKey(false);
    setTestingApi('idle');
    setTestMsg('');
    setTestModels([]);
    setShowAddApi(true);
  };

  // 独立的测试连接函数
  const testApiConnection = async () => {
    if (!apiForm.endpoint.trim() || !getEffectiveApiKey()) {
      setTestingApi('fail');
      setTestMsg('请先填写 Endpoint 和 API Key');
      return;
    }
    setTestingApi('loading');
    setTestMsg('正在连接...');
    setTestModels([]);
    try {
      const models = await api.fetchModels(apiForm.endpoint.trim(), getEffectiveApiKey());
      const list: string[] = models?.data?.map((m: any) => m.id).filter(Boolean) || [];
      if (list.length > 0) {
        setTestModels(list);
        setTestingApi('success');
        setTestMsg(`连接成功 · 获取到 ${list.length} 个模型`);
      } else {
        setTestingApi('fail');
        setTestMsg('连接成功但未返回模型列表');
      }
    } catch (e: any) {
      setTestingApi('fail');
      const err = e?.message || String(e);
      setTestMsg(err.includes('abort') ? '请求超时（10s），请检查网络' : `连接失败：${err}`);
    }
  };

  const handleSaveApi = async () => {
    if (!apiForm.endpoint.trim()) {
      Alert.alert('Frapi AI', 'Endpoint 为必填项');
      return;
    }
    const isEdit = editingIdx != null;
    // 新增必须填写 Key；编辑时 Key 留空则沿用原密钥（不回显明文，保护隐私）
    if (!isEdit && !apiForm.apiKey.trim()) {
      Alert.alert('Frapi AI', '新增 API 必须填写 API Key');
      return;
    }
    const finalKey = getEffectiveApiKey();
    // 用已测试到的模型，或者手动输入的模型，或者重新获取一次
    let list: string[] = [...testModels];
    if (list.length === 0) {
      try {
        const models = await api.fetchModels(apiForm.endpoint.trim(), finalKey);
        list = models?.data?.map((m: any) => m.id).filter(Boolean) || [];
      } catch { /* 自动获取失败，使用手动输入 */ }
    }
    // 合并手动输入的模型
    const manual = (apiForm.models || '')
      .split(/[,，\n;；]/)
      .map((s: string) => s.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...list, ...manual]));
    if (merged.length === 0) {
      Alert.alert('Frapi AI', '未能自动获取模型，请手动输入模型名称（逗号分隔）');
      return;
    }
    const finalName = apiForm.name.trim() || '未命名 API';
    const apis: any[] = [...(config.third_party_apis || [])];
    if (isEdit) {
      // 编辑：保留原对象中未在表单暴露的字段，仅覆盖四项（manual_models 供对话页自动同步时保留手动模型）
      apis[editingIdx as number] = {
        ...apis[editingIdx as number],
        name: finalName,
        endpoint: apiForm.endpoint.trim(),
        apiKey: finalKey,
        models: merged,
        manual_models: manual,
      };
    } else {
      apis.push({ name: finalName, endpoint: apiForm.endpoint.trim(), apiKey: finalKey, models: merged, manual_models: manual });
    }
    const newConfig = { ...config, third_party_apis: apis };
    let finalConfig = newConfig;
    // 编辑后若当前选中的第三方模型已不在新模型列表中，自动回退官方 API，避免引用失效
    if (isEdit) {
      const cur = String(newConfig.current_model || '');
      if (cur.startsWith(`tp:${editingIdx}:`)) {
        const curModel = cur.split(':').slice(2).join(':');
        if (!merged.includes(curModel)) finalConfig = { ...newConfig, current_model: 'frapi' };
      }
    }
    await api.saveConfig(finalConfig);
    setConfig(finalConfig);
    setApiForm({ name: '', endpoint: '', apiKey: '', models: '' });
    setShowKey(false);
    setTestingApi('idle');
    setTestMsg('');
    setTestModels([]);
    setEditingIdx(null);
    setShowAddApi(false);
    Alert.alert('Frapi AI', (isEdit ? '修改成功' : '添加成功') + '，共 ' + merged.length + ' 个模型');
  };

  // 删除第三方 API（二次确认）；若当前对话正在使用它，自动回退官方 API
  const removeApi = (idx: number) => {
    const tp = config.third_party_apis?.[idx];
    const doRemove = () => {
      const newApis = (config.third_party_apis || []).filter((_: any, i: number) => i !== idx);
      let newConfig: any = { ...config, third_party_apis: newApis };
      if ((newConfig.current_model || '').startsWith(`tp:${idx}:`)) {
        newConfig = { ...newConfig, current_model: 'frapi' };
      }
      api.saveConfig(newConfig);
      setConfig(newConfig);
    };
    if (Platform.OS === 'web') {
      if (window.confirm(`确定删除第三方 API「${tp?.name || ''}」？`)) doRemove();
    } else {
      Alert.alert('删除第三方 API', `确定删除「${tp?.name || '未命名 API'}」吗？删除后不可恢复。`, [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: doRemove },
      ]);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: C.bg }]}>
      {/* 顶栏：对话/设置 分段切换 */}
      <View style={[styles.header, { backgroundColor: C.card, borderBottomColor: C.border }]}>
        <View style={[styles.segment, { backgroundColor: C.btnBg }]}>
          <TouchableOpacity style={styles.segItem} onPress={() => router.replace('/')}>
            <ThemedText style={{ color: C.btnText }}>对话</ThemedText>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.segItem, { backgroundColor: C.accent }]}>
            <ThemedText style={styles.segActiveText}>设置</ThemedText>
          </TouchableOpacity>
        </View>
      </View>

    <ScrollView style={[styles.container, { backgroundColor: C.bg }]} contentContainerStyle={styles.scrollContent}>

      {/* 账户卡片 */}
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.border }]}>
        <View style={styles.accountRow}>
          <View style={[styles.avatar, { backgroundColor: C.accent }]}>
            <ThemedText style={styles.avatarText}>{(config.username || 'U').charAt(0).toUpperCase()}</ThemedText>
          </View>
          <View style={{ flex: 1 }}>
            <ThemedText type="subtitle">{maskUsername(config.username || '')}</ThemedText>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: '#34C759' }]} />
              <ThemedText style={{ color: C.sub, fontSize: 12 }}>已连接官方 API</ThemedText>
            </View>
          </View>
          <TouchableOpacity onPress={handleLogout} style={[styles.logoutBtn, { borderColor: C.danger }]}>
            <ThemedText style={{ color: C.danger, fontSize: 13 }}>退出</ThemedText>
          </TouchableOpacity>
        </View>
      </View>

      {/* 统计卡片 */}
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.border }]}>
        <ThemedText style={styles.sectionTitle}>使用统计</ThemedText>
        {/* 三栏 flex:1 均分，中间用分隔线隔开，无嵌套背景 */}
        <View style={[styles.stats, { borderBottomColor: C.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
          <View style={[styles.statBox]}>
            <ThemedText style={[styles.statLabel, { color: C.sub }]}>💰 余额</ThemedText>
            <ThemedText style={[styles.balanceText, { color: C.accent }]}>${Number(config.balance ?? 0).toFixed(2)}</ThemedText>
          </View>
          <View style={[styles.statSep, { backgroundColor: C.border }]} />
          <View style={[styles.statBox]}>
            <ThemedText style={[styles.statLabel, { color: C.sub }]}>⚡ 今日</ThemedText>
            <ThemedText style={styles.statValue}>{(todayUsage?.tokens || 0).toLocaleString()}</ThemedText>
            <ThemedText style={[styles.hint, { color: C.sub }]}>{todayUsage?.count || 0} 次</ThemedText>
          </View>
          <View style={[styles.statSep, { backgroundColor: C.border }]} />
          <View style={[styles.statBox]}>
            <ThemedText style={[styles.statLabel, { color: C.sub }]}>📊 累计</ThemedText>
            <ThemedText style={styles.statValue}>{(config.usage?.total || 0).toLocaleString()}</ThemedText>
            <ThemedText style={[styles.hint, { color: C.sub }]}>{config.usage?.count || 0} 次</ThemedText>
          </View>
        </View>
        <TouchableOpacity style={[styles.btn, { backgroundColor: C.accent, marginTop: 14 }]} onPress={() => setShowRecharge(true)}>
          <ThemedText style={styles.btnText}>💵 充值</ThemedText>
        </TouchableOpacity>
      </View>

      {/* 官方 API Keys 卡片：所有 key 共用同一智能模型池，可切换当前使用的 key */}
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.border, padding: 14 }]}>
        <View style={styles.row}>
          <ThemedText style={styles.sectionTitle}>🔑 官方 API</ThemedText>
          <ThemedText style={{ color: C.sub, fontSize: 12 }}>{config.api_keys?.length || 0} 个 Key · 共用智能模型池</ThemedText>
        </View>
        {(config.api_keys?.length || 0) === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 14 }}>
            <ThemedText style={{ color: C.sub, fontSize: 13 }}>暂无 API Key，请退出后重新登录同步</ThemedText>
          </View>
        ) : (
          config.api_keys.map((key: string, i: number) => {
            const meta = config.api_key_meta?.find((t: any) => t.token_key === key);
            const active = key === config.primary_api_key;
            const label = meta?.name || meta?.token_name || `Key ${i + 1}`;
            const masked = key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : key;
            return (
              <TouchableOpacity
                key={key}
                onPress={() => switchPrimaryKey(key)}
                style={[
                  styles.keyItem,
                  { backgroundColor: C.bg, borderColor: active ? C.accent : C.border },
                  active && { borderWidth: 2 },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <ThemedText style={{ fontSize: 14, fontWeight: '600', ...(active ? { color: C.accent } : {}) }}>
                    {label}{active ? ' · 使用中' : ''}
                  </ThemedText>
                  <ThemedText style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{masked}</ThemedText>
                </View>
                <View style={[styles.radio, { borderColor: active ? C.accent : C.sub }]}>
                  {active && <View style={[styles.radioDot, { backgroundColor: C.accent }]} />}
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </View>

      {/* 第三方 API 卡片 */}
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.border, padding: 14 }]}>
        <View style={styles.row}>
          <ThemedText style={styles.sectionTitle}>第三方 API</ThemedText>
          <TouchableOpacity onPress={openAddApiModal}>
            <ThemedText style={{ color: C.accent, fontWeight: '500' }}>＋ 添加</ThemedText>
          </TouchableOpacity>
        </View>
        {(config.third_party_apis || []).length === 0 ? (
          <View style={styles.emptyCard}>
            <ThemedText style={{ fontSize: 28 }}>🔌</ThemedText>
            <ThemedText style={[styles.hint, { color: C.sub, marginTop: 8 }]}>暂无第三方 API</ThemedText>
            <ThemedText style={[styles.hint, { color: C.sub, marginTop: 4 }]}>添加后自动获取可用模型列表</ThemedText>
          </View>
        ) : (
          (config.third_party_apis || []).map((tp: any, idx: number) => (
            <View key={idx} style={[styles.apiItem, { borderBottomColor: C.border }]}>
              <View style={[styles.apiDot, { backgroundColor: C.accent }]} />
              <View style={{ flex: 1 }}>
                <ThemedText style={{ fontWeight: '500' }}>{tp.name || '未命名 API'}</ThemedText>
                <ThemedText style={[styles.hint, { color: C.sub }]} numberOfLines={1}>{tp.endpoint}</ThemedText>
                {/* API Key 脱敏展示，不泄露完整密钥 */}
                {!!tp.apiKey && (
                  <ThemedText style={[styles.hint, { color: C.sub, fontSize: 11 }]} numberOfLines={1}>
                    🔑 {maskApiKey(tp.apiKey)}
                  </ThemedText>
                )}
                <View style={styles.apiMeta}>
                  <View style={[styles.modelBadge, { backgroundColor: C.accentSoft }]}>
                    <ThemedText style={{ color: C.accent, fontSize: 11 }}>{(tp.models || []).length} 个模型</ThemedText>
                  </View>
                </View>
              </View>
              <View style={styles.apiActions}>
                <TouchableOpacity onPress={() => openEditApiModal(idx)} style={[styles.editBtn, { borderColor: C.accent }]}>
                  <ThemedText style={{ color: C.accent, fontSize: 12 }}>编辑</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => removeApi(idx)} style={[styles.deleteBtn, { borderColor: C.danger }]}>
                  <ThemedText style={{ color: C.danger, fontSize: 12 }}>删除</ThemedText>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </View>

      {/* 外观主题卡片 */}
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.border, padding: 14 }]}>
        <ThemedText style={styles.sectionTitle}>🎨 外观</ThemedText>
        <View style={styles.themeRow}>
          {(['auto', 'light', 'dark'] as ThemeMode[]).map((m) => (
            <TouchableOpacity
              key={m}
              style={[
                styles.themeOption,
                { backgroundColor: C.bg, borderColor: mode === m ? C.accent : C.border },
                mode === m && { borderWidth: 2 },
              ]}
              onPress={() => setMode(m)}
            >
              <ThemedText style={{ fontSize: 20 }}>
                {m === 'auto' ? '🔄' : m === 'light' ? '☀️' : '🌙'}
              </ThemedText>
              <ThemedText style={[styles.themeLabel, { color: mode === m ? C.accent : C.sub }]}>
                {m === 'auto' ? '跟随系统' : m === 'light' ? '浅色' : '深色'}
              </ThemedText>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* 充值弹窗 */}
      <Modal visible={showRecharge} animationType="slide" transparent>
        <View style={[styles.modalMask, { backgroundColor: C.mask }]}>
          <View style={[styles.modal, { backgroundColor: C.panel }]}>
            <ThemedText type="subtitle">充值</ThemedText>
            <TextInput
              style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]}
              placeholder="请输入充值卡密"
              placeholderTextColor={C.sub}
              value={voucher}
              onChangeText={setVoucher}
            />
            <View style={styles.buyRow}>
              <TouchableOpacity onPress={() => Linking.openURL('https://m.tb.cn/h.8IHpiRW?tk=5yN3TjFuZ3R')} style={[styles.buyOption, { backgroundColor: C.bg, borderColor: C.border }]}>
                <ThemedText style={[styles.buyIcon, { color: C.accent }]}>🛒</ThemedText>
                <ThemedText style={styles.buyLabel}>购买卡密</ThemedText>
                <ThemedText style={[styles.buyHint, { color: C.sub }]}>官方店铺</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity onPress={async () => { await Clipboard.setStringAsync('xsirchats'); Alert.alert('已复制', '微信号 xsirchats 已复制到剪贴板，请打开微信添加好友'); }} style={[styles.buyOption, { backgroundColor: C.bg, borderColor: C.border }]}>
                <ThemedText style={[styles.buyIcon, { color: '#07C160' }]}>💬</ThemedText>
                <ThemedText style={styles.buyLabel}>联系微信</ThemedText>
                <ThemedText style={[styles.buyHint, { color: C.sub }]}>xsirchats</ThemedText>
              </TouchableOpacity>
            </View>
            <View style={styles.modalBtns}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: C.cancelBg }]} onPress={() => { setVoucher(''); setShowRecharge(false); }}>
                <ThemedText style={{ color: C.cancelText }}>取消</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: C.accent }]} onPress={handleRecharge} disabled={busy}>
                <ThemedText style={styles.btnText}>{busy ? '处理中...' : '确认'}</ThemedText>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 添加/编辑第三方 API 弹窗 — 商用级分组卡片 + 图标 + 即时反馈 + 连接测试 */}
      <Modal visible={showAddApi} animationType="slide" transparent onRequestClose={() => { setShowAddApi(false); setEditingIdx(null); }}>
        <View style={[styles.modalMask, { backgroundColor: C.mask }]}>
          <SafeAreaView style={{ flex: 1, justifyContent: 'flex-end' }}>
            <View style={[styles.apiModal, { backgroundColor: C.panel }]}>
              {/* 顶部标题栏 */}
              <View style={styles.apiModalHeader}>
                <TouchableOpacity
                  onPress={() => { setShowAddApi(false); setEditingIdx(null); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <ThemedText style={{ fontSize: 22, color: C.sub, lineHeight: 24 }}>×</ThemedText>
                </TouchableOpacity>
                <View style={{ alignItems: 'center' }}>
                  <ThemedText style={styles.apiModalTitle}>{editingIdx != null ? '编辑第三方 API' : '添加第三方 API'}</ThemedText>
                  <ThemedText style={[styles.apiModalSubtitle, { color: C.sub }]}>
                    {editingIdx != null ? '修改配置 · 密钥留空则保持不变' : '支持 OpenAI 兼容接口'}
                  </ThemedText>
                </View>
                <View style={{ width: 24 }} />
              </View>

              <ScrollView style={styles.apiModalScroll} contentContainerStyle={{ gap: 14, paddingBottom: 20 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

                {/* 📌 基本信息 */}
                <View style={[styles.apiGroupCard, { backgroundColor: C.bg, borderColor: C.border }]}>
                  <View style={styles.apiGroupHeader}>
                    <ThemedText style={styles.apiGroupIcon}>📌</ThemedText>
                    <ThemedText style={styles.apiGroupTitle}>基本信息</ThemedText>
                  </View>
                  <View style={[styles.apiField, { backgroundColor: C.inputBg, borderColor: C.border }]}>
                    <ThemedText style={[styles.apiFieldIcon, { color: C.sub }]}>🏷️</ThemedText>
                    <TextInput
                      style={[styles.apiFieldInput, { color: C.cancelText }]}
                      placeholder="API 别名（如 MyProvider）"
                      placeholderTextColor={C.sub}
                      value={apiForm.name}
                      onChangeText={(v) => setApiForm({ ...apiForm, name: v })}
                    />
                  </View>
                </View>

                {/* 🔗 连接配置 */}
                <View style={[styles.apiGroupCard, { backgroundColor: C.bg, borderColor: C.border }]}>
                  <View style={styles.apiGroupHeader}>
                    <ThemedText style={styles.apiGroupIcon}>🔗</ThemedText>
                    <ThemedText style={styles.apiGroupTitle}>连接配置</ThemedText>
                  </View>

                  {/* Endpoint 输入 */}
                  <View style={[styles.apiField, { backgroundColor: C.inputBg, borderColor: C.border }]}>
                    <ThemedText style={[styles.apiFieldIcon, { color: C.sub }]}>🌐</ThemedText>
                    <TextInput
                      style={[styles.apiFieldInput, { color: C.cancelText }]}
                      placeholder="https://api.openai.com"
                      placeholderTextColor={C.sub}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      value={apiForm.endpoint}
                      onChangeText={(v) => {
                        setApiForm({ ...apiForm, endpoint: v });
                        // endpoint 变动后重置连接状态
                        if (testingApi !== 'idle') { setTestingApi('idle'); setTestMsg(''); setTestModels([]); }
                      }}
                    />
                  </View>
                  {/* 清洗预览提示 */}
                  {endpointWasCleaned && (
                    <View style={[styles.apiPreviewHint, { backgroundColor: C.accentSoft }]}>
                      <ThemedText style={[styles.apiPreviewIcon, { color: C.accent }]}>✨</ThemedText>
                      <View style={{ flex: 1 }}>
                        <ThemedText style={{ fontSize: 11, color: C.accent, fontWeight: '500' }}>已自动清洗 Endpoint</ThemedText>
                        <ThemedText style={{ fontSize: 11, color: C.sub, marginTop: 2 }} numberOfLines={1}>
                          {cleanedEndpoint}
                        </ThemedText>
                      </View>
                    </View>
                  )}
                  {!endpointWasCleaned && apiForm.endpoint.trim() && !apiForm.endpoint.trim().startsWith('http') && (
                    <View style={[styles.apiPreviewHint, { backgroundColor: '#FFF3E0' }]}>
                      <ThemedText style={{ fontSize: 11, color: '#F57C02', flex: 1 }}>⚠️ Endpoint 需以 https:// 开头</ThemedText>
                    </View>
                  )}

                  {/* API Key 输入（编辑时不回显明文，留空即保持原密钥） */}
                  <View style={[styles.apiField, { backgroundColor: C.inputBg, borderColor: C.border, marginTop: 10 }]}>
                    <ThemedText style={[styles.apiFieldIcon, { color: C.sub }]}>🔑</ThemedText>
                    <TextInput
                      style={[styles.apiFieldInput, { color: C.cancelText }]}
                      placeholder={editingIdx != null
                        ? `已配置 ${maskApiKey(config?.third_party_apis?.[editingIdx]?.apiKey || '')}，留空不修改`
                        : 'sk-...'}
                      placeholderTextColor={C.sub}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry={!showKey}
                      value={apiForm.apiKey}
                      onChangeText={(v) => {
                        setApiForm({ ...apiForm, apiKey: v });
                        if (testingApi !== 'idle') { setTestingApi('idle'); setTestMsg(''); setTestModels([]); }
                      }}
                    />
                    <TouchableOpacity onPress={() => setShowKey(!showKey)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <ThemedText style={{ fontSize: 16, color: C.sub }}>{showKey ? '🙈' : '👁️'}</ThemedText>
                    </TouchableOpacity>
                  </View>
                  {editingIdx != null && !apiForm.apiKey && (
                    <View style={[styles.apiPreviewHint, { backgroundColor: C.accentSoft }]}>
                      <ThemedText style={{ fontSize: 11, color: C.accent, flex: 1 }}>
                        🔒 出于隐私保护，密钥不回显；仅在需要更换时输入新密钥
                      </ThemedText>
                    </View>
                  )}

                  {/* 测试连接按钮 + 状态指示 */}
                  <TouchableOpacity
                    style={[
                      styles.apiTestBtn,
                      { borderColor: testingApi === 'loading' ? C.accent : C.border },
                      testingApi === 'success' && { borderColor: '#34C759', backgroundColor: 'rgba(52,199,89,0.08)' },
                      testingApi === 'fail' && { borderColor: C.danger, backgroundColor: testingApi === 'fail' ? 'rgba(229,62,62,0.06)' : undefined },
                    ]}
                    onPress={testApiConnection}
                    disabled={testingApi === 'loading'}
                    activeOpacity={0.7}
                  >
                    {testingApi === 'loading' ? (
                      <ActivityIndicator size="small" color={C.accent} />
                    ) : (
                      <ThemedText style={{ fontSize: 14 }}>
                        {testingApi === 'success' ? '✅' : testingApi === 'fail' ? '❌' : '🔗'}
                      </ThemedText>
                    )}
                    <ThemedText style={{ fontSize: 13, fontWeight: '500', marginLeft: 6, color: testingApi === 'success' ? '#34C759' : testingApi === 'fail' ? C.danger : C.cancelText }}>
                      {testingApi === 'loading' ? '测试中...' : testingApi === 'success' ? testMsg : testingApi === 'fail' ? testMsg || '连接失败' : '测试连接'}
                    </ThemedText>
                  </TouchableOpacity>
                </View>

                {/* 🤖 模型配置 */}
                <View style={[styles.apiGroupCard, { backgroundColor: C.bg, borderColor: C.border }]}>
                  <View style={styles.apiGroupHeader}>
                    <ThemedText style={styles.apiGroupIcon}>🤖</ThemedText>
                    <ThemedText style={styles.apiGroupTitle}>模型配置</ThemedText>
                    {testModels.length > 0 && (
                      <View style={[styles.modelBadge, { backgroundColor: C.accentSoft }]}>
                        <ThemedText style={{ color: C.accent, fontSize: 11 }}>{testModels.length} 个已获取</ThemedText>
                      </View>
                    )}
                  </View>
                  <View style={[styles.apiField, { backgroundColor: C.inputBg, borderColor: C.border, minHeight: 80, alignItems: 'flex-start' }]}>
                    <ThemedText style={[styles.apiFieldIcon, { color: C.sub, marginTop: 12 }]}>📋</ThemedText>
                    <TextInput
                      style={[styles.apiFieldInput, { color: C.cancelText, flex: 1, paddingVertical: 10 }]}
                      placeholder={testingApi === 'success' ? '已自动获取模型，可额外补充（逗号分隔）' : '自动获取失败时，请手动输入模型名（逗号分隔）'}
                      placeholderTextColor={C.sub}
                      autoCapitalize="none"
                      multiline
                      value={apiForm.models}
                      onChangeText={(v) => setApiForm({ ...apiForm, models: v })}
                    />
                  </View>
                  {/* 已获取模型预览胶囊列表 */}
                  {testModels.length > 0 && (
                    <View style={styles.apiModelChips}>
                      {testModels.slice(0, 8).map((m) => (
                        <View key={m} style={[styles.apiChip, { backgroundColor: C.card, borderColor: C.border }]}>
                          <ThemedText style={{ fontSize: 11, color: C.sub }} numberOfLines={1}>{m}</ThemedText>
                        </View>
                      ))}
                      {testModels.length > 8 && (
                        <View style={[styles.apiChip, { backgroundColor: C.accentSoft }]}>
                          <ThemedText style={{ fontSize: 11, color: C.accent }}>+{testModels.length - 8}</ThemedText>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              </ScrollView>

              {/* 底部操作按钮 */}
              <View style={[styles.apiModalFooter, { borderTopColor: C.border, backgroundColor: C.panel }]}>
                <TouchableOpacity
                  style={[styles.apiFooterBtn, { backgroundColor: C.cancelBg }]}
                  onPress={() => {
                    setShowAddApi(false);
                    setEditingIdx(null);
                    setTestingApi('idle');
                    setTestMsg('');
                    setTestModels([]);
                  }}
                  activeOpacity={0.7}
                >
                  <ThemedText style={{ color: C.cancelText, fontWeight: '500' }}>取消</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.apiFooterBtn,
                    { backgroundColor: C.accent, shadowColor: C.accent, shadowOpacity: 0.3, shadowOffset: { width: 0, height: 2 }, shadowRadius: 4, elevation: 3 },
                    // 新增：endpoint + key 都必填；编辑：endpoint 必填（key 留空沿用原值）
                    (!apiForm.endpoint.trim() || (editingIdx == null && !apiForm.apiKey.trim())) && { opacity: 0.4 },
                  ]}
                  onPress={handleSaveApi}
                  disabled={busy}
                  activeOpacity={0.7}
                >
                  <ThemedText style={{ color: '#FFF', fontWeight: '600' }}>
                    {busy ? '保存中...' : editingIdx != null ? '保存修改' : '保存 API'}
                  </ThemedText>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, gap: 8 },
  segment: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  segItem: { paddingHorizontal: 14, height: 32, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  segActiveText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  scrollContent: { padding: 16, gap: 12 },
  center: { justifyContent: 'center', alignItems: 'center', gap: 16 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFF', fontSize: 18, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  logoutBtn: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18 },
  sectionTitle: { fontSize: 15, fontWeight: '600', marginBottom: 12 },
  keyItem: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 8 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  stats: { flexDirection: 'row', alignItems: 'stretch', marginTop: 4 },
  statBox: { flex: 1, alignItems: 'center', paddingVertical: 14, gap: 2 },
  statSep: { width: StyleSheet.hairlineWidth, marginVertical: 10 },
  balanceText: { fontSize: 20, fontWeight: '700' },
  statValue: { fontSize: 18, fontWeight: '600' },
  statLabel: { fontSize: 12, marginBottom: 2 },
  btn: { padding: 14, borderRadius: 12, alignItems: 'center', elevation: 3, shadowColor: '#007AFF', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4 },
  btnText: { color: '#FFF', fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hint: { fontSize: 12 },
  emptyCard: { alignItems: 'center', paddingVertical: 20 },
  apiItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  apiDot: { width: 8, height: 8, borderRadius: 4, alignSelf: 'flex-start', marginTop: 6 },
  apiMeta: { flexDirection: 'row', gap: 6, marginTop: 4 },
  modelBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  themeRow: { flexDirection: 'row', gap: 10 },
  themeOption: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: 14, borderRadius: 12, borderWidth: 1 },
  themeLabel: { fontSize: 12, fontWeight: '500' },
  deleteBtn: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  editBtn: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  apiActions: { flexDirection: 'column', gap: 6, alignItems: 'flex-end' },
  modalMask: { flex: 1, justifyContent: 'center', padding: 24 },
  modal: { borderRadius: 16, padding: 20, gap: 10 },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalBtn: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center' },
  input: { borderWidth: 1, padding: 12, borderRadius: 10 },
  buyRow: { flexDirection: 'row', gap: 10 },
  buyOption: { flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 12, borderWidth: 1, gap: 3 },
  buyIcon: { fontSize: 22 },
  buyLabel: { fontSize: 13, fontWeight: '600' },
  buyHint: { fontSize: 11 },

  // ===== 添加第三方 API 弹窗 =====
  apiModal: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingBottom: 0,
    maxHeight: '88%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 10,
  },
  apiModalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 },
  apiModalTitle: { fontSize: 16, fontWeight: '700' },
  apiModalSubtitle: { fontSize: 11, marginTop: 2 },
  apiModalScroll: { paddingHorizontal: 16 },
  apiModalFooter: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
  apiFooterBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },

  apiGroupCard: { borderRadius: 14, borderWidth: 1, padding: 14 },
  apiGroupHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  apiGroupIcon: { fontSize: 15 },
  apiGroupTitle: { fontSize: 13, fontWeight: '600', flex: 1 },

  apiField: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, minHeight: 44 },
  apiFieldIcon: { fontSize: 15, marginRight: 8 },
  apiFieldInput: { flex: 1, fontSize: 14, paddingVertical: 10 },

  apiPreviewHint: { flexDirection: 'row', alignItems: 'center', marginTop: 8, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, gap: 6 },
  apiPreviewIcon: { fontSize: 13 },

  apiTestBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 14, paddingVertical: 11, borderRadius: 10, borderWidth: 1 },

  apiModelChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  apiChip: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, maxWidth: 140 },
});
