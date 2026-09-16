import React, { useState, useCallback, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView, Platform, SafeAreaView, Modal, Alert, Image, useColorScheme } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';
import LoginScreen from './login';

const BUILTIN_ENDPOINT = 'https://api.frapi.kdns.fr';

type Msg = { role: string; content: string; image?: string | null };

const palettes = {
  light: { bg: '#F8F9FA', headerBg: '#FFFFFF', border: '#E5E5EA', sub: '#8E8E93', btnBg: '#F0F2F5', btnText: '#333333', accent: '#007AFF', accentSoft: '#E8F1FF', inputBg: '#F0F0F0', aiBubble: '#E9E9EB', aiText: '#000000', panelBg: '#FFFFFF', danger: '#E53E3E' },
  dark: { bg: '#000000', headerBg: '#1C1C1E', border: '#2C2C2E', sub: '#8E8E93', btnBg: '#2C2C2E', btnText: '#E5E5EA', accent: '#0A84FF', accentSoft: '#1A3A5C', inputBg: '#1C1C1E', aiBubble: '#2C2C2E', aiText: '#FFFFFF', panelBg: '#1C1C1E', danger: '#FF6B6B' },
};

export default function ChatScreen() {
  const scheme = useColorScheme();
  const C = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const [config, setConfig] = useState<any>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sessionId, setSessionId] = useState('default_session');
  const [input, setInput] = useState('');
  const [model, setModel] = useState('frapi');
  const [image, setImage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const listRef = useRef<FlatList<Msg>>(null);

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
    <SafeAreaView style={[styles.container, { backgroundColor: C.bg }]}>
      <View style={[styles.header, { backgroundColor: C.headerBg, borderBottomColor: C.border }]}>
        <TouchableOpacity style={[styles.headerBtn, { backgroundColor: C.btnBg }]} onPress={() => { loadSessions(); setShowHistory(true); }}>
          <ThemedText style={[styles.headerBtnText, { color: C.btnText }]}>☰ 历史</ThemedText>
        </TouchableOpacity>
        <View style={styles.modelPicker}>
          <Picker selectedValue={model} onValueChange={(item) => setModel(item)} style={styles.picker}>
            <Picker.Item label="官方 API" value="frapi" />
            {(config?.third_party_apis || []).map((tp: any, idx: number) =>
              (tp.models || []).map((m: string) => (
                <Picker.Item key={`tp-${idx}-${m}`} label={`${tp.name || 'API'} · ${m}`} value={`tp:${idx}:${m}`} />
              ))
            )}
          </Picker>
        </View>
        <TouchableOpacity style={[styles.headerBtn, { backgroundColor: C.accentSoft }]} onPress={newChat}>
          <ThemedText style={[styles.newChatBtnText, { color: C.accent }]}>＋ 新对话</ThemedText>
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
            <View style={[styles.msgBubble, item.role === 'user'
              ? { backgroundColor: C.accent }
              : { backgroundColor: C.aiBubble }]}>
              {!!item.image && <Image source={{ uri: item.image }} style={styles.msgImage} resizeMode="cover" />}
              {!!item.content && (
                <ThemedText style={[styles.msgText, { color: item.role === 'user' ? '#FFFFFF' : C.aiText }]}>
                  {item.content}
                </ThemedText>
              )}
            </View>
          )}
        />

        {!!image && (
          <View style={[styles.previewBar, { backgroundColor: C.headerBg }]}>
            <Image source={{ uri: image }} style={styles.previewThumb} resizeMode="cover" />
            <TouchableOpacity style={styles.previewRemove} onPress={() => setImage(null)}>
              <Text style={styles.previewRemoveText}>✕</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={[styles.inputBar, { backgroundColor: C.headerBg, borderTopColor: C.border }]}>
          {Platform.OS !== 'web' && (
            <TouchableOpacity style={styles.attachBtn} onPress={() => pickImage(true)}>
              <Text style={styles.attachIcon}>📷</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.attachBtn} onPress={() => pickImage(false)}>
            <Text style={styles.attachIcon}>🖼️</Text>
          </TouchableOpacity>
          <TextInput
            style={[styles.input, { backgroundColor: C.inputBg, color: C.aiText }]}
            value={input}
            onChangeText={setInput}
            placeholder="输入消息..."
            placeholderTextColor={C.sub}
            multiline
          />
          <TouchableOpacity
            style={[styles.sendBtn, { backgroundColor: sending ? C.sub : C.accent }]}
            onPress={sendMessage}
            disabled={sending}
          >
            <ThemedText style={styles.sendText}>{sending ? '...' : '发送'}</ThemedText>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={showHistory} animationType="slide" transparent onRequestClose={() => setShowHistory(false)}>
        <View style={styles.modalMask}>
          <View style={[styles.historyPanel, { backgroundColor: C.panelBg }]}>
            <View style={styles.historyHeader}>
              <ThemedText type="subtitle">历史会话</ThemedText>
              <View style={{ flexDirection: 'row', gap: 16 }}>
                <TouchableOpacity onPress={newChat}><ThemedText style={{ color: C.accent }}>＋ 新对话</ThemedText></TouchableOpacity>
                <TouchableOpacity onPress={() => setShowHistory(false)}><ThemedText style={{ color: C.sub }}>关闭</ThemedText></TouchableOpacity>
              </View>
            </View>
            {sessions.length === 0 ? (
              <ThemedText style={{ color: C.sub }}>暂无历史会话</ThemedText>
            ) : (
              <FlatList
                data={sessions}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <View style={[styles.sessionItem, { borderBottomColor: C.border }]}>
                    <TouchableOpacity style={{ flex: 1 }} onPress={() => openSession(item.id)}>
                      <ThemedText numberOfLines={1} style={item.id === sessionId ? { color: C.accent, fontWeight: '600' } : undefined}>
                        {item.title}{item.id === sessionId ? ' （当前）' : ''}
                      </ThemedText>
                      {!!item.updatedAt && (
                        <ThemedText style={{ color: C.sub, fontSize: 12 }}>{new Date(item.updatedAt).toLocaleString()}</ThemedText>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeSession(item.id)}>
                      <ThemedText style={{ color: C.danger, fontSize: 13 }}>删除</ThemedText>
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
  container: { flex: 1 },
  content: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1, gap: 6 },
  headerBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  headerBtnText: { fontSize: 13 },
  newChatBtnText: { fontSize: 13, fontWeight: '600' },
  modelPicker: { flex: 1, height: 40 },
  picker: { flex: 1 },
  listContent: { padding: 16 },
  msgBubble: { padding: 12, borderRadius: 18, marginVertical: 6, maxWidth: '85%' },
  msgImage: { width: 200, height: 200, borderRadius: 12, marginBottom: 6 },
  msgText: { fontSize: 15, lineHeight: 21 },
  previewBar: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8 },
  previewThumb: { width: 64, height: 64, borderRadius: 8 },
  previewRemove: { marginLeft: 8, width: 22, height: 22, borderRadius: 11, backgroundColor: '#E53E3E', alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  previewRemoveText: { color: '#FFF', fontSize: 12, lineHeight: 14 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, borderTopWidth: 1, gap: 6 },
  attachBtn: { width: 38, height: 40, justifyContent: 'center', alignItems: 'center' },
  attachIcon: { fontSize: 22 },
  input: { flex: 1, minHeight: 40, maxHeight: 100, borderRadius: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, fontSize: 16 },
  sendBtn: { marginLeft: 2, height: 40, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 20 },
  sendText: { color: '#FFF', fontWeight: '600' },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  historyPanel: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: '70%' },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sessionItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
});
