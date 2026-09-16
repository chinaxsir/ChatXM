import React, { useState, useCallback } from 'react';
import { StyleSheet, View, TextInput, TouchableOpacity, ScrollView, Modal, Alert } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';

export default function SettingsScreen() {
  const [config, setConfig] = useState<any>(null);
  const [showRecharge, setShowRecharge] = useState(false);
  const [showAddApi, setShowAddApi] = useState(false);
  const [voucher, setVoucher] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiForm, setApiForm] = useState({ name: '', endpoint: '', apiKey: '' });
  const router = useRouter();

  // 每次切到该 Tab 时重新读取配置并刷新余额
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

  if (!config?.session_token) {
    return (
      <View style={[styles.container, styles.center]}>
        <ThemedText>尚未登录</ThemedText>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/login')}>
          <ThemedText style={styles.btnText}>去登录</ThemedText>
        </TouchableOpacity>
      </View>
    );
  }

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

  const handleLogout = () => {
    Alert.alert('退出登录', '确定要退出当前账号吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定',
        style: 'destructive',
        onPress: async () => {
          await api.clearConfig();
          router.replace('/login');
        },
      },
    ]);
  };

  const removeApi = (idx: number) => {
    const newApis = (config.third_party_apis || []).filter((_: any, i: number) => i !== idx);
    const newConfig = { ...config, third_party_apis: newApis };
    api.saveConfig(newConfig);
    setConfig(newConfig);
  };

  return (
    <ScrollView style={styles.container}>
      {/* 账户信息 */}
      <View style={styles.section}>
        <View style={styles.row}>
          <ThemedText type="subtitle">{config.username || '已登录'}</ThemedText>
          <TouchableOpacity onPress={handleLogout}><ThemedText style={styles.link}>退出登录</ThemedText></TouchableOpacity>
        </View>
        <View style={styles.stats}>
          <View style={styles.statBox}>
            <ThemedText>余额</ThemedText>
            <ThemedText type="subtitle">${Number(config.balance ?? 0).toFixed(2)}</ThemedText>
          </View>
          <View style={styles.statBox}>
            <ThemedText>API Keys</ThemedText>
            <ThemedText type="subtitle">{(config.api_keys || []).length}</ThemedText>
          </View>
        </View>
      </View>

      {/* 充值入口 */}
      <TouchableOpacity style={styles.btn} onPress={() => setShowRecharge(true)}>
        <ThemedText style={styles.btnText}>💵 充值</ThemedText>
      </TouchableOpacity>

      {/* 第三方 API 列表 */}
      <View style={styles.section}>
        <View style={styles.row}>
          <ThemedText type="subtitle">第三方 API</ThemedText>
          <TouchableOpacity onPress={() => setShowAddApi(true)}>
            <ThemedText style={styles.link}>+ 添加</ThemedText>
          </TouchableOpacity>
        </View>
        {(config.third_party_apis || []).length === 0 ? (
          <ThemedText style={styles.hint}>暂无第三方 API，添加后自动获取模型列表</ThemedText>
        ) : (
          (config.third_party_apis || []).map((tp: any, idx: number) => (
            <View key={idx} style={styles.apiItem}>
              <View style={{ flex: 1 }}>
                <ThemedText>{tp.name || '未命名 API'}</ThemedText>
                <ThemedText style={styles.hint}>{tp.endpoint} · {(tp.models || []).length} 个模型</ThemedText>
              </View>
              <TouchableOpacity onPress={() => removeApi(idx)}>
                <ThemedText style={{ color: '#E53E3E' }}>删除</ThemedText>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      {/* 充值弹窗 */}
      <Modal visible={showRecharge} animationType="slide" transparent>
        <View style={styles.modalMask}>
          <View style={styles.modal}>
            <ThemedText type="subtitle">充值</ThemedText>
            <TextInput style={styles.input} placeholder="请输入充值卡密" value={voucher} onChangeText={setVoucher} />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnCancel]} onPress={() => { setVoucher(''); setShowRecharge(false); }}>
                <ThemedText>取消</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnOk]} onPress={handleRecharge} disabled={busy}>
                <ThemedText style={styles.btnText}>{busy ? '处理中...' : '确认'}</ThemedText>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 添加 API 弹窗 */}
      <Modal visible={showAddApi} animationType="slide" transparent>
        <View style={styles.modalMask}>
          <View style={styles.modal}>
            <ThemedText type="subtitle">添加第三方 API</ThemedText>
            <TextInput style={styles.input} placeholder="API 别名（可选，如 OpenAI）" onChangeText={(v) => setApiForm({ ...apiForm, name: v })} />
            <TextInput style={styles.input} placeholder="Endpoint（如 https://api.openai.com）" autoCapitalize="none" onChangeText={(v) => setApiForm({ ...apiForm, endpoint: v })} />
            <TextInput style={styles.input} placeholder="API Key（sk-...）" autoCapitalize="none" secureTextEntry onChangeText={(v) => setApiForm({ ...apiForm, apiKey: v })} />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnCancel]} onPress={() => setShowAddApi(false)}>
                <ThemedText>取消</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnOk]} onPress={handleAddApi} disabled={busy}>
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
  stats: { flexDirection: 'row', justifyContent: 'space-around', marginVertical: 10 },
  statBox: { alignItems: 'center', gap: 4 },
  btn: { backgroundColor: '#007AFF', padding: 15, borderRadius: 8, alignItems: 'center', marginVertical: 10 },
  btnText: { color: '#FFF' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { color: '#007AFF' },
  hint: { color: '#999', fontSize: 12, marginTop: 2 },
  apiItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EEE' },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#FFF', borderRadius: 12, padding: 20, gap: 10 },
  modalBtns: { flexDirection: 'row', gap: 10 },
  modalBtn: { flex: 1, padding: 12, borderRadius: 8, alignItems: 'center' },
  modalBtnCancel: { backgroundColor: '#F0F0F0' },
  modalBtnOk: { backgroundColor: '#007AFF' },
  input: { borderWidth: 1, borderColor: '#DDD', padding: 10, borderRadius: 8 },
});
