import React, { useState, useCallback, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView, Platform, SafeAreaView, Modal, Alert, Image } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';
import LoginScreen from './login';

const BUILTIN_ENDPOINT = 'https://api.frapi.kdns.fr';

type Msg = { role: string; content: string; image?: string | null };

export default function ChatScreen() {
  const [config, setConfig] = useState<any>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sessionId, setSessionId] = useState('default_session');
  const [input, setInput] = useState('');
  const [model, setModel] = useState('frapi');
  const [image, setImage] = useState<string | null>(null); // data URL 待发送
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const listRef = useRef<FlatList<Msg>>(null);

  // 页面聚焦时重载配置（支持退出重登）
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const c = await api.loadConfig();
        if (!active) return;
        setConfig(c);
        if (c?.current_model) setModel(c.current_model);
      })();
      return () => { active = false; };
    }, [])
  );

  // 切换会话时加载对应历史
  useEffect(() => {
    let active = true;
    (async () => {
      const hist = await api.loadHistory(sessionId);
      if (active) setMessages(hist);
    })();
    return () => { active = false; };
  }, [sessionId]);

  const loadSessions = useCallback(async () => {
    setSessions(await api.listSessions());
  }, []);

  const newChat = () => {
    setSessionId('s_' + Date.now().toString(36));
    setMessages([]);
    setInput('');
    setImage(null);
    setShowHistory(false);
  };

  const openSession = (id: string) => {
    setSessionId(id);
    setShowHistory(false);
  };

  const removeSession = (id: string) => {
    const doDelete = async () => {
      await api.deleteSession(id);
      if (id === sessionId) newChat();
      loadSessions();
    };
    if (Platform.OS === 'web') {
      if (window.confirm('删除该会话？')) doDelete();
    } else {
      Alert.alert('删除会话', '删除后不可恢复，确定吗？', [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  // 选择图片（拍照或相册），压缩后转为 data URL
  const pickImage = async (useCamera: boolean) => {
    try {
      const options: any = { mediaTypes: ['images'], quality: 0.6, base64: true, allowsEditing: false };
      const perm = useCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') { alert('需要授权访问' + (useCamera ? '相机' : '相册')); return; }

      const result = useCamera
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled || !result.assets?.[0]) return;
      const asset: any = result.assets[0];

      // 压缩到宽 1024，控制 base64 体积
      let dataUrl = '';
      try {
        const rendered = await ImageManipulator.manipulate(asset.uri).resize({ width: 1024 }).renderAsync();
        const saved = await rendered.saveAsync({ compress: 0.6, format: SaveFormat.JPEG, base64: true });
        dataUrl = `data:image/jpeg;base64,${saved.base64}`;
      } catch {
        dataUrl = asset.base64
          ? `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`
          : asset.uri;
      }
      setImage(dataUrl);
    } catch (e: any) {
      alert('获取图片失败: ' + (e?.message || e));
    }
  };

  const resolveTarget = () => {
    if (model.startsWith('tp:')) {
      const [, idxStr, ...rest] = model.split(':');
      const tp = config?.third_party_apis?.[Number(idxStr)];
      if (tp) return { endpoint: tp.endpoint, token: tp.apiKey, model: rest.join(':') };
    }
    return { endpoint: config?.builtin_endpoint || BUILTIN_ENDPOINT, token: config?.primary_api_key, model };
  };

  const sendMessage = async () => {
    if (sending) return;
    if (!input.trim() && !image) return;
    if (!config) return;
    const target = resolveTarget();
    if (!target.token) {
      alert('未配置 API Key，请重新登录或在设置中添加 API');
      return;
    }

    const userMsg: Msg = { role: 'user', content: input, image };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setImage(null);
    setSending(true);

    try {
      const response = await api.sendChatRequest({
        endpoint: target.endpoint,
        token: target.token,
        model: target.model,
        prompt: userMsg.content,
        image: userMsg.image || undefined,
        history: JSON.stringify(messages)
      });

      if (response?.choices?.[0]?.message?.content) {
        const updatedMessages = [...newMessages, { role: 'assistant', content: response.choices[0].message.content }];
        await api.saveHistory(sessionId, updatedMessages);
        setMessages(updatedMessages);

        // 累计 Token 消耗统计（总计 + 按天）
        const usage: any = response.usage || {};
        const day = new Date().toISOString().slice(0, 10);
        const u = config.usage || { total: 0, prompt: 0, completion: 0, count: 0, daily: {} as any };
        const total = usage.total_tokens ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        const d = u.daily[day] || { tokens: 0, count: 0 };
        const newConfig = {
          ...config,
          usage: {
            total: (u.total || 0) + total,
            prompt: (u.prompt || 0) + (usage.prompt_tokens || 0),
            completion: (u.completion || 0) + (usage.completion_tokens || 0),
            count: (u.count || 0) + 1,
            daily: { ...u.daily, [day]: { tokens: d.tokens + total, count: d.count + 1 } },
          },
        };
        await api.saveConfig(newConfig);
        setConfig(newConfig);
      } else {
        throw new Error(JSON.stringify(response));
      }
    } catch (e: any) {
      alert('对话请求失败: ' + (e?.message || e));
      console.error(e);
    } finally {
      setSending(false);
    }
  };

  const handleLoginSuccess = async () => {
    const c = await api.loadConfig();
    setConfig(c);
  };

  if (!config) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* 顶栏：历史 | 模型选择 | 新对话 */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerBtn} onPress={() => { loadSessions(); setShowHistory(true); }}>
          <ThemedText style={styles.headerBtnText}>☰ 历史</ThemedText>
        </TouchableOpacity>
        <View style={styles.modelPicker}>
          <Picker selectedValue={model} onValueChange={(item) => setModel(item)} style={styles.picker}>
            <Picker.Item label="frapi (智能选择)" value="frapi" />
            {(config?.third_party_apis || []).map((tp: any, idx: number) =>
              (tp.models || []).map((m: string) => (
                <Picker.Item key={`tp-${idx}-${m}`} label={`${tp.name || 'API'} · ${m}`} value={`tp:${idx}:${m}`} />
              ))
            )}
          </Picker>
        </View>
        <TouchableOpacity style={[styles.headerBtn, styles.newChatBtn]} onPress={newChat}>
          <ThemedText style={styles.newChatBtnText}>＋ 新对话</ThemedText>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.content}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(_, index) => index.toString()}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => (
            <View style={[styles.msgBubble, item.role === 'user' ? styles.userBubble : styles.aiBubble]}>
              {!!item.image && <Image source={{ uri: item.image }} style={styles.msgImage} resizeMode="cover" />}
              {!!item.content && (
                <ThemedText style={item.role === 'user' ? styles.userText : styles.aiText}>
                  {item.content}
                </ThemedText>
              )}
            </View>
          )}
        />

        {/* 待发送图片预览 */}
        {!!image && (
          <View style={styles.previewBar}>
            <Image source={{ uri: image }} style={styles.previewThumb} resizeMode="cover" />
            <TouchableOpacity style={styles.previewRemove} onPress={() => setImage(null)}>
              <Text style={styles.previewRemoveText}>✕</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* 输入区：拍照 | 相册 | 输入框 | 发送 */}
        <View style={styles.inputBar}>
          {Platform.OS !== 'web' && (
            <TouchableOpacity style={styles.attachBtn} onPress={() => pickImage(true)}>
              <Text style={styles.attachIcon}>📷</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.attachBtn} onPress={() => pickImage(false)}>
            <Text style={styles.attachIcon}>🖼️</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="输入消息..."
            placeholderTextColor="#999"
            multiline
          />
          <TouchableOpacity style={[styles.sendBtn, sending && styles.sendBtnDisabled]} onPress={sendMessage} disabled={sending}>
            <ThemedText style={styles.sendText}>{sending ? '...' : '发送'}</ThemedText>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* 历史会话弹窗 */}
      <Modal visible={showHistory} animationType="slide" transparent onRequestClose={() => setShowHistory(false)}>
        <View style={styles.modalMask}>
          <View style={styles.historyPanel}>
            <View style={styles.historyHeader}>
              <ThemedText type="subtitle">历史会话</ThemedText>
              <View style={{ flexDirection: 'row', gap: 16 }}>
                <TouchableOpacity onPress={newChat}><ThemedText style={styles.link}>＋ 新对话</ThemedText></TouchableOpacity>
                <TouchableOpacity onPress={() => setShowHistory(false)}><ThemedText style={styles.hint}>关闭</ThemedText></TouchableOpacity>
              </View>
            </View>
            {sessions.length === 0 ? (
              <ThemedText style={styles.hint}>暂无历史会话</ThemedText>
            ) : (
              <FlatList
                data={sessions}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <View style={styles.sessionItem}>
                    <TouchableOpacity style={{ flex: 1 }} onPress={() => openSession(item.id)}>
                      <ThemedText numberOfLines={1} style={item.id === sessionId ? styles.sessionActive : undefined}>
                        {item.title}{item.id === sessionId ? ' （当前）' : ''}
                      </ThemedText>
                      {!!item.updatedAt && (
                        <ThemedText style={styles.hint}>{new Date(item.updatedAt).toLocaleString()}</ThemedText>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeSession(item.id)}>
                      <ThemedText style={styles.deleteText}>删除</ThemedText>
                    </TouchableOpacity>
                  </View>
                )}
              />
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  content: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#EEE', gap: 6 },
  headerBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: '#F0F2F5' },
  headerBtnText: { fontSize: 13 },
  newChatBtn: { backgroundColor: '#E8F1FF' },
  newChatBtnText: { fontSize: 13, color: '#007AFF', fontWeight: '600' },
  modelPicker: { flex: 1, height: 40 },
  picker: { flex: 1 },
  listContent: { padding: 16 },
  msgBubble: { padding: 12, borderRadius: 18, marginVertical: 6, maxWidth: '85%' },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#007AFF' },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: '#E5E5EA' },
  msgImage: { width: 200, height: 200, borderRadius: 12, marginBottom: 6 },
  userText: { color: '#FFF' },
  aiText: { color: '#000' },
  previewBar: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, backgroundColor: '#FFF' },
  previewThumb: { width: 64, height: 64, borderRadius: 8 },
  previewRemove: { marginLeft: 8, width: 22, height: 22, borderRadius: 11, backgroundColor: '#E53E3E', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  previewRemoveText: { color: '#FFF', fontSize: 12, lineHeight: 14 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#EEE', gap: 6 },
  attachBtn: { width: 38, height: 40, justifyContent: 'center', alignItems: 'center' },
  attachIcon: { fontSize: 22 },
  input: { flex: 1, minHeight: 40, maxHeight: 100, backgroundColor: '#F0F0F0', borderRadius: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, fontSize: 16 },
  sendBtn: { marginLeft: 2, height: 40, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 20, backgroundColor: '#007AFF' },
  sendBtnDisabled: { backgroundColor: '#A0C4FF' },
  sendText: { color: '#FFF', fontWeight: '600' },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  historyPanel: { backgroundColor: '#FFF', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: '70%' },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  link: { color: '#007AFF' },
  hint: { color: '#999', fontSize: 12 },
  sessionItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EEE', gap: 8 },
  sessionActive: { color: '#007AFF', fontWeight: '600' },
  deleteText: { color: '#E53E3E', fontSize: 13 },
});
