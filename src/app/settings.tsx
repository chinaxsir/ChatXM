import React, { useState, useCallback } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ScrollView, Modal, Alert, Platform, SafeAreaView } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useThemeMode, ThemeMode } from '@/hooks/useThemeMode';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';

const palettes = {
  light: { bg: '#F5F6F8', card: '#FFFFFF', border: '#E5E5EA', sub: '#8E8E93', inputBg: '#F5F6F8', accent: '#007AFF', accentSoft: '#E8F1FF', danger: '#E53E3E', mask: 'rgba(0,0,0,0.4)', panel: '#FFFFFF', cancelBg: '#F0F0F0', cancelText: '#333333', btnBg: '#F0F2F5', btnText: '#333333' },
  dark: { bg: '#000000', card: '#1C1C1E', border: '#2C2C2E', sub: '#8E8E93', inputBg: '#2C2C2E', accent: '#0A84FF', accentSoft: '#1A3A5C', danger: '#FF6B6B', mask: 'rgba(0,0,0,0.6)', panel: '#1C1C1E', cancelBg: '#2C2C2E', cancelText: '#E5E5EA', btnBg: '#2C2C2E', btnText: '#E5E5EA' },
};

export default function SettingsScreen() {
  const { mode, scheme, setMode } = useThemeMode();
  const C = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const [config, setConfig] = useState<any>(null);
  const [showRecharge, setShowRecharge] = useState(false);
  const [showAddApi, setShowAddApi] = useState(false);
  const [voucher, setVoucher] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiForm, setApiForm] = useState({ name: '', endpoint: '', apiKey: '', models: '' });
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const c = await api.loadConfig();
        if (!active) return;
        setConfig(c);
        if (c?.session_token) {
          try {
            const r = await api.refreshAccount(c.session_token);
            if (!active || !r) return;
            const balance = r?.data?.balance ?? r?.balance ?? r?.data?.user?.balance;
            if (balance != null) {
              const updated = { ...c, balance };
              await api.saveConfig(updated);
              setConfig(updated);
            }
          } catch { /* 静默失败，保留本地余额 */ }
        }
      })();
      return () => { active = false; };
    }, [])
  );

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
    if (!voucher.trim()) { alert('请输入卡密'); return; }
    setBusy(true);
    try {
      const res = await api.recharge(config.session_token, voucher.trim());
      if (res?.status === 'success') {
        alert('充值成功' + (res?.data?.amount != null ? `，到账 ${res.data.amount}` : ''));
        setVoucher('');
        setShowRecharge(false);
        const updated = { ...config, balance: res?.data?.balance ?? config.balance };
        await api.saveConfig(updated);
        setConfig(updated);
      } else {
        const msg = res?.error?.message || res?.data?.message || res?.message || '卡密无效或已被使用';
        alert('充值失败: ' + msg);
      }
    } catch (e: any) {
      alert('充值失败: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const handleAddApi = async () => {
    if (!apiForm.endpoint.trim() || !apiForm.apiKey.trim()) {
      alert('Endpoint 和 API Key 为必填项');
      return;
    }
    setBusy(true);
    try {
      let list: string[] = [];
      // 先尝试自动获取
      try {
        const models = await api.fetchModels(apiForm.endpoint.trim(), apiForm.apiKey.trim());
        list = models?.data?.map((m: any) => m.id).filter(Boolean) || [];
      } catch {
        // 自动获取失败，使用手动输入
      }
      // 合并手动输入的模型（逗号/换行/分号分隔）
      const manual = (apiForm.models || '')
        .split(/[,，\n;；]/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      const merged = Array.from(new Set([...list, ...manual]));
      if (merged.length === 0) {
        alert('未能自动获取模型，请手动输入模型名称（逗号分隔）');
        return;
      }
      const newApis = [...(config.third_party_apis || []), { name: apiForm.name, endpoint: apiForm.endpoint.trim(), apiKey: apiForm.apiKey.trim(), models: merged }];
      const newConfig = { ...config, third_party_apis: newApis };
      await api.saveConfig(newConfig);
      setConfig(newConfig);
      setApiForm({ name: '', endpoint: '', apiKey: '', models: '' });
      setShowAddApi(false);
      alert('添加成功，共 ' + merged.length + ' 个模型');
    } catch {
      alert('添加失败，请检查网络或手动输入模型名称');
    } finally {
      setBusy(false);
    }
  };

  const removeApi = (idx: number) => {
    const newApis = (config.third_party_apis || []).filter((_: any, i: number) => i !== idx);
    const newConfig = { ...config, third_party_apis: newApis };
    api.saveConfig(newConfig);
    setConfig(newConfig);
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
            <ThemedText type="subtitle">{config.username || '已登录用户'}</ThemedText>
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
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.border, padding: 14 }]}>
        <ThemedText style={styles.sectionTitle}>使用统计</ThemedText>
        <View style={styles.stats}>
          <View style={[styles.statBox, { backgroundColor: C.bg }]}>
            <ThemedText style={[styles.statLabel, { color: C.sub }]}>💰 余额</ThemedText>
            <ThemedText type="title" style={{ color: C.accent }}>${Number(config.balance ?? 0).toFixed(2)}</ThemedText>
          </View>
          <View style={[styles.statBox, { backgroundColor: C.bg }]}>
            <ThemedText style={[styles.statLabel, { color: C.sub }]}>⚡ 今日</ThemedText>
            <ThemedText type="subtitle">{(todayUsage?.tokens || 0).toLocaleString()}</ThemedText>
            <ThemedText style={[styles.hint, { color: C.sub, fontSize: 11 }]}>{todayUsage?.count || 0} 次</ThemedText>
          </View>
          <View style={[styles.statBox, { backgroundColor: C.bg }]}>
            <ThemedText style={[styles.statLabel, { color: C.sub }]}>📊 累计</ThemedText>
            <ThemedText type="subtitle">{(config.usage?.total || 0).toLocaleString()}</ThemedText>
            <ThemedText style={[styles.hint, { color: C.sub, fontSize: 11 }]}>{config.usage?.count || 0} 次</ThemedText>
          </View>
        </View>
        <TouchableOpacity style={[styles.btn, { backgroundColor: C.accent, marginTop: 14 }]} onPress={() => setShowRecharge(true)}>
          <ThemedText style={styles.btnText}>💵 充值</ThemedText>
        </TouchableOpacity>
      </View>

      {/* 第三方 API 卡片 */}
      <View style={[styles.card, { backgroundColor: C.card, borderColor: C.border, padding: 14 }]}>
        <View style={styles.row}>
          <ThemedText style={styles.sectionTitle}>第三方 API</ThemedText>
          <TouchableOpacity onPress={() => setShowAddApi(true)}>
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
                <View style={styles.apiMeta}>
                  <View style={[styles.modelBadge, { backgroundColor: C.accentSoft }]}>
                    <ThemedText style={{ color: C.accent, fontSize: 11 }}>{(tp.models || []).length} 个模型</ThemedText>
                  </View>
                </View>
              </View>
              <TouchableOpacity onPress={() => removeApi(idx)} style={[styles.deleteBtn, { borderColor: C.danger }]}>
                <ThemedText style={{ color: C.danger, fontSize: 12 }}>删除</ThemedText>
              </TouchableOpacity>
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

      {/* 添加 API 弹窗 */}
      <Modal visible={showAddApi} animationType="slide" transparent>
        <View style={[styles.modalMask, { backgroundColor: C.mask }]}>
          <View style={[styles.modal, { backgroundColor: C.panel }]}>
            <ThemedText type="subtitle">添加第三方 API</ThemedText>
            <TextInput
              style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]}
              placeholder="API 别名（可选，如 OpenAI）"
              placeholderTextColor={C.sub}
              onChangeText={(v) => setApiForm({ ...apiForm, name: v })}
            />
            <TextInput
              style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]}
              placeholder="Endpoint（如 https://api.openai.com）"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              onChangeText={(v) => setApiForm({ ...apiForm, endpoint: v })}
            />
            <TextInput
              style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]}
              placeholder="API Key（sk-...）"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              secureTextEntry
              onChangeText={(v) => setApiForm({ ...apiForm, apiKey: v })}
            />
            <TextInput
              style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]}
              placeholder="模型（可选，自动获取失败时手动填写，逗号分隔）"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              value={apiForm.models}
              onChangeText={(v) => setApiForm({ ...apiForm, models: v })}
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: C.cancelBg }]} onPress={() => setShowAddApi(false)}>
                <ThemedText style={{ color: C.cancelText }}>取消</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: C.accent }]} onPress={handleAddApi} disabled={busy}>
                <ThemedText style={styles.btnText}>{busy ? '获取中...' : '保存'}</ThemedText>
              </TouchableOpacity>
            </View>
          </View>
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
  card: { borderRadius: 16, borderWidth: 1, padding: 16, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFF', fontSize: 18, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  logoutBtn: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18 },
  sectionTitle: { fontSize: 15, fontWeight: '600', marginBottom: 12 },
  stats: { flexDirection: 'row', gap: 8 },
  statBox: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 12, paddingHorizontal: 4, borderRadius: 12 },
  statLabel: { fontSize: 12 },
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
  modalMask: { flex: 1, justifyContent: 'center', padding: 24 },
  modal: { borderRadius: 16, padding: 20, gap: 10 },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalBtn: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center' },
  input: { borderWidth: 1, padding: 12, borderRadius: 10 },
});
