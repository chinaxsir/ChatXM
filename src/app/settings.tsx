import React, { useState, useCallback } from 'react';
import { StyleSheet, View, TextInput, TouchableOpacity, ScrollView, Modal, Alert, Platform, useColorScheme } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';

const palettes = {
  light: { bg: '#F8F9FA', card: '#FFFFFF', border: '#E5E5EA', sub: '#8E8E93', inputBg: '#FFFFFF', accent: '#007AFF', accentSoft: '#E8F1FF', danger: '#E53E3E', mask: 'rgba(0,0,0,0.4)', panel: '#FFFFFF', cancelBg: '#F0F0F0', cancelText: '#333333' },
  dark: { bg: '#000000', card: '#1C1C1E', border: '#2C2C2E', sub: '#8E8E93', inputBg: '#2C2C2E', accent: '#0A84FF', accentSoft: '#1A3A5C', danger: '#FF6B6B', mask: 'rgba(0,0,0,0.6)', panel: '#1C1C1E', cancelBg: '#2C2C2E', cancelText: '#E5E5EA' },
};

export default function SettingsScreen() {
  const scheme = useColorScheme();
  const C = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const [config, setConfig] = useState<any>(null);
  const [showRecharge, setShowRecharge] = useState(false);
  const [showAddApi, setShowAddApi] = useState(false);
  const [voucher, setVoucher] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiForm, setApiForm] = useState({ name: '', endpoint: '', apiKey: '' });
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
    router.replace('/login');
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
      const models = await api.fetchModels(apiForm.endpoint.trim(), apiForm.apiKey.trim());
      const list = models?.data?.map((m: any) => m.id).filter(Boolean) || [];
      const newApis = [...(config.third_party_apis || []), { ...apiForm, endpoint: apiForm.endpoint.trim(), apiKey: apiForm.apiKey.trim(), models: list }];
      const newConfig = { ...config, third_party_apis: newApis };
      await api.saveConfig(newConfig);
      setConfig(newConfig);
      setApiForm({ name: '', endpoint: '', apiKey: '' });
      setShowAddApi(false);
      alert('添加成功，已获取 ' + list.length + ' 个模型');
    } catch {
      alert('添加失败，请检查 Endpoint 和 API Key');
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
    <ScrollView style={[styles.container, { backgroundColor: C.bg }]}>
      {/* 账户信息 */}
      <View style={styles.section}>
        <View style={styles.row}>
          <ThemedText type="subtitle">{config.username || '已登录'}</ThemedText>
          <TouchableOpacity onPress={handleLogout}><ThemedText style={{ color: C.danger }}>退出登录</ThemedText></TouchableOpacity>
        </View>
        <View style={styles.stats}>
          <View style={[styles.statBox, { backgroundColor: C.card, borderColor: C.border }]}>
            <ThemedText style={styles.statLabel}>余额</ThemedText>
            <ThemedText type="subtitle">${Number(config.balance ?? 0).toFixed(2)}</ThemedText>
          </View>
          <View style={[styles.statBox, { backgroundColor: C.card, borderColor: C.border }]}>
            <ThemedText style={styles.statLabel}>今日消耗</ThemedText>
            <ThemedText type="subtitle">{(todayUsage?.tokens || 0).toLocaleString()}</ThemedText>
            <ThemedText style={[styles.hint, { color: C.sub }]}>{todayUsage?.count || 0} 次对话</ThemedText>
          </View>
          <View style={[styles.statBox, { backgroundColor: C.card, borderColor: C.border }]}>
            <ThemedText style={styles.statLabel}>累计消耗</ThemedText>
            <ThemedText type="subtitle">{(config.usage?.total || 0).toLocaleString()}</ThemedText>
            <ThemedText style={[styles.hint, { color: C.sub }]}>{config.usage?.count || 0} 次对话</ThemedText>
          </View>
        </View>
      </View>

      {/* 充值入口 */}
      <TouchableOpacity style={[styles.btn, { backgroundColor: C.accent }]} onPress={() => setShowRecharge(true)}>
        <ThemedText style={styles.btnText}>💵 充值</ThemedText>
      </TouchableOpacity>

      {/* 第三方 API 列表 */}
      <View style={styles.section}>
        <View style={styles.row}>
          <ThemedText type="subtitle">第三方 API</ThemedText>
          <TouchableOpacity onPress={() => setShowAddApi(true)}>
            <ThemedText style={{ color: C.accent }}>＋ 添加</ThemedText>
          </TouchableOpacity>
        </View>
        {(config.third_party_apis || []).length === 0 ? (
          <ThemedText style={[styles.hint, { color: C.sub }]}>暂无第三方 API，添加后自动获取模型列表</ThemedText>
        ) : (
          (config.third_party_apis || []).map((tp: any, idx: number) => (
            <View key={idx} style={[styles.apiItem, { borderBottomColor: C.border }]}>
              <View style={{ flex: 1 }}>
                <ThemedText>{tp.name || '未命名 API'}</ThemedText>
                <ThemedText style={[styles.hint, { color: C.sub }]}>{tp.endpoint} · {(tp.models || []).length} 个模型</ThemedText>
              </View>
              <TouchableOpacity onPress={() => removeApi(idx)}>
                <ThemedText style={{ color: C.danger }}>删除</ThemedText>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      {/* 充值弹窗 */}
      <Modal visible={showRecharge} animationType="slide" transparent>
        <View style={[styles.modalMask, { backgroundColor: C.mask }]}>
          <View style={[styles.modal, { backgroundColor: C.panel }]}>
            <ThemedText type="subtitle">充值</ThemedText>
            <TextInput style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]} placeholder="请输入充值卡密" placeholderTextColor={C.sub} value={voucher} onChangeText={setVoucher} />
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
            <TextInput style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]} placeholder="API 别名（可选，如 OpenAI）" placeholderTextColor={C.sub} onChangeText={(v) => setApiForm({ ...apiForm, name: v })} />
            <TextInput style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]} placeholder="Endpoint（如 https://api.openai.com）" placeholderTextColor={C.sub} autoCapitalize="none" onChangeText={(v) => setApiForm({ ...apiForm, endpoint: v })} />
            <TextInput style={[styles.input, { backgroundColor: C.inputBg, borderColor: C.border, color: C.cancelText }]} placeholder="API Key（sk-...）" placeholderTextColor={C.sub} autoCapitalize="none" secureTextEntry onChangeText={(v) => setApiForm({ ...apiForm, apiKey: v })} />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: C.cancelBg }]} onPress={() => setShowAddApi(false)}>
                <ThemedText style={{ color: C.cancelText }}>取消</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: C.accent }]} onPress={handleAddApi} disabled={busy}>
                <ThemedText style={styles.btnText}>{busy ? '获取中...' : '保存并获取模型'}</ThemedText>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  center: { justifyContent: 'center', alignItems: 'center', gap: 16 },
  section: { marginVertical: 16 },
  stats: { flexDirection: 'row', gap: 10, marginVertical: 10 },
  statBox: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 12, borderRadius: 12, borderWidth: 1 },
  statLabel: { fontSize: 12 },
  btn: { padding: 15, borderRadius: 12, alignItems: 'center', marginVertical: 10 },
  btnText: { color: '#FFF' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hint: { fontSize: 12, marginTop: 2 },
  apiItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  modalMask: { flex: 1, justifyContent: 'center', padding: 24 },
  modal: { borderRadius: 16, padding: 20, gap: 10 },
  modalBtns: { flexDirection: 'row', gap: 10 },
  modalBtn: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center' },
  input: { borderWidth: 1, padding: 10, borderRadius: 10 },
});
