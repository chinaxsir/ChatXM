import React, { useState, useEffect } from 'react';
import { StyleSheet, View, TextInput, TouchableOpacity, ScrollView, Modal } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';

export default function SettingsScreen() {
  const [config, setConfig] = useState<any>({});
  const [showRecharge, setShowRecharge] = useState(false);
  const [showAddApi, setShowAddApi] = useState(false);
  const [voucher, setVoucher] = useState('');
  const [apiForm, setApiForm] = useState({ name: '', endpoint: '', apiKey: '' });

  useEffect(() => { loadConfig(); }, []);

  const loadConfig = async () => {
    const c = await api.loadConfig();
    setConfig(c || {});
  };

  const handleRecharge = async () => {
    const res = await api.recharge(config.session_token, voucher);
    if (res.status === 'success') {
      alert('充值成功');
      setShowRecharge(false);
      loadConfig();
    } else {
      alert('充值失败: ' + res.message);
    }
  };

  const handleAddApi = async () => {
    try {
      const models = await api.fetchModels(apiForm.endpoint, apiForm.apiKey);
      const newApis = [...(config.third_party_apis || []), { ...apiForm, models: models.data?.map((m:any) => m.id) || [] }];
      const newConfig = { ...config, third_party_apis: newApis };
      await api.saveConfig(newConfig);
      setConfig(newConfig);
      setShowAddApi(false);
    } catch {
      alert('添加失败，请检查配置');
    }
  };

  return (
    <ScrollView style={styles.container}>
      {/* Token 统计 */}
      <View style={styles.section}>
        <ThemedText type="subtitle">Token 消费明细</ThemedText>
        <View style={styles.stats}>
          <View style={styles.statBox}><ThemedText>总计</ThemedText><ThemedText type="subtitle">{config?.total_tokens || 0}</ThemedText></View>
        </View>
      </View>

      {/* 充值入口 */}
      <TouchableOpacity style={styles.btn} onPress={() => setShowRecharge(true)}><ThemedText style={styles.btnText}>💵 充值</ThemedText></TouchableOpacity>

      {/* 第三方 API 列表 */}
      <View style={styles.section}>
        <View style={styles.row}>
          <ThemedText type="subtitle">第三方 API</ThemedText>
          <TouchableOpacity onPress={() => setShowAddApi(true)}><ThemedText style={{color: '#007AFF'}}>+ 添加</ThemedText></TouchableOpacity>
        </View>
      </View>

      {/* 充值弹窗 */}
      <Modal visible={showRecharge} animationType="slide">
        <View style={styles.modal}><TextInput style={styles.input} placeholder="卡密" value={voucher} onChangeText={setVoucher} /><TouchableOpacity style={styles.btn} onPress={handleRecharge}><ThemedText style={styles.btnText}>确认</ThemedText></TouchableOpacity></View>
      </Modal>

      {/* 添加 API 弹窗 */}
      <Modal visible={showAddApi} animationType="slide">
        <View style={styles.modal}>
          <TextInput style={styles.input} placeholder="别名" onChangeText={(v) => setApiForm({...apiForm, name: v})} />
          <TextInput style={styles.input} placeholder="Endpoint" onChangeText={(v) => setApiForm({...apiForm, endpoint: v})} />
          <TextInput style={styles.input} placeholder="Key" onChangeText={(v) => setApiForm({...apiForm, apiKey: v})} />
          <TouchableOpacity style={styles.btn} onPress={handleAddApi}><ThemedText style={styles.btnText}>保存并获取模型</ThemedText></TouchableOpacity>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  section: { marginVertical: 16 },
  stats: { flexDirection: 'row', justifyContent: 'space-around', marginVertical: 10 },
  statBox: { alignItems: 'center' },
  btn: { backgroundColor: '#007AFF', padding: 15, borderRadius: 8, alignItems: 'center', marginVertical: 10 },
  btnText: { color: '#FFF' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  modal: { flex: 1, justifyContent: 'center', padding: 20 },
  input: { borderWidth: 1, borderColor: '#DDD', padding: 10, marginBottom: 10, borderRadius: 5 }
});