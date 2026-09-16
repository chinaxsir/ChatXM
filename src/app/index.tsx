import React, { useState, useCallback } from 'react';
import { StyleSheet, View, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView, Platform, SafeAreaView } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { useFocusEffect } from 'expo-router';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';
import LoginScreen from './login';

const BUILTIN_ENDPOINT = 'https://api.frapi.kdns.fr';

export default function ChatScreen() {
  const [config, setConfig] = useState<any>(null);
  const [messages, setMessages] = useState<{ role: string, content: string }[]>([]);
  const [sessionId] = useState("default_session");
  const [input, setInput] = useState('');
  const [model, setModel] = useState('frapi');

  // 每次切到该 Tab 时重新读取配置与历史（支持退出重登）
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const c = await api.loadConfig();
        if (!active) return;
        setConfig(c);
        if (c) {
          if (c.current_model) setModel(c.current_model);
          const hist = await api.loadHistory(sessionId);
          if (active) setMessages(hist);
        }
      })();
      return () => { active = false; };
    }, [sessionId])
  );

  // 解析所选模型：tp:序号:模型名 → 第三方 API；否则内置
  const resolveTarget = () => {
    if (model.startsWith('tp:')) {
      const [, idxStr, ...rest] = model.split(':');
      const tp = config?.third_party_apis?.[Number(idxStr)];
      if (tp) return { endpoint: tp.endpoint, token: tp.apiKey, model: rest.join(':') };
    }
    return { endpoint: config?.builtin_endpoint || BUILTIN_ENDPOINT, token: config?.primary_api_key, model };
  };

  const sendMessage = async () => {
    if (!input.trim() || !config) return;
    const target = resolveTarget();
    if (!target.token) {
      alert('未配置 API Key，请重新登录或在设置中添加 API');
      return;
    }

    const userMsg = { role: 'user', content: input };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');

    try {
      const response = await api.sendChatRequest({
        endpoint: target.endpoint,
        token: target.token,
        model: target.model,
        prompt: input,
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
      <View style={styles.modelPickerContainer}>
        <Picker selectedValue={model} onValueChange={(item) => setModel(item)}>
          <Picker.Item label="frapi (智能选择)" value="frapi" />
          {(config?.third_party_apis || []).map((tp: any, idx: number) =>
            (tp.models || []).map((m: string) => (
              <Picker.Item key={`tp-${idx}-${m}`} label={`${tp.name || 'API'} · ${m}`} value={`tp:${idx}:${m}`} />
            ))
          )}
        </Picker>
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.content}>
        <FlatList
          data={messages}
          keyExtractor={(_, index) => index.toString()}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={[styles.msgBubble, item.role === 'user' ? styles.userBubble : styles.aiBubble]}>
              <ThemedText style={item.role === 'user' ? styles.userText : styles.aiText}>
                {item.content}
              </ThemedText>
            </View>
          )}
        />
        <View style={styles.inputBar}>
          <TextInput 
            style={styles.input} 
            value={input} 
            onChangeText={setInput} 
            placeholder="输入消息..." 
            placeholderTextColor="#999"
          />
          <TouchableOpacity style={styles.sendBtn} onPress={sendMessage}>
            <ThemedText style={styles.sendText}>发送</ThemedText>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  content: { flex: 1 },
  listContent: { padding: 16 },
  msgBubble: { padding: 12, borderRadius: 18, marginVertical: 6, maxWidth: '85%' },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#007AFF' },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: '#E5E5EA' },
  userText: { color: '#FFF' },
  aiText: { color: '#000' },
  inputBar: { flexDirection: 'row', padding: 12, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#EEE' },
  input: { flex: 1, height: 40, backgroundColor: '#F0F0F0', borderRadius: 20, paddingHorizontal: 16, fontSize: 16 },
  sendBtn: { marginLeft: 10, justifyContent: 'center', paddingHorizontal: 16 },
  sendText: { color: '#007AFF', fontWeight: '600' },
  modelPickerContainer: { height: 50, borderBottomWidth: 1, borderBottomColor: '#EEE' }
});
