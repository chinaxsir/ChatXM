import React, { useState, useEffect } from 'react';
import { StyleSheet, View, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView, Platform, SafeAreaView } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';
import LoginScreen from './login';

export default function ChatScreen() {
  const [config, setConfig] = useState<any>(null);
  const [messages, setMessages] = useState<{ role: string, content: string }[]>([]);
  const [sessionId] = useState("default_session");
  const [input, setInput] = useState('');
  const [model, setModel] = useState('frapi');

  useEffect(() => {
    async function load() {
      const c = await api.loadConfig();
      setConfig(c);
      if (c) {
        const hist = await api.loadHistory(sessionId);
        setMessages(hist);
      }
    }
    load();
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || !config) return;
    
    const userMsg = { role: 'user', content: input };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');

    try {
      const response = await api.sendChatRequest({
        endpoint: config.builtin_endpoint || "https://api.frapi.kdns.fr",
        token: config.primary_api_key,
        model: model,
        prompt: input,
        history: JSON.stringify(messages)
      });
      
      if (response?.choices?.[0]?.message?.content) {
        const updatedMessages = [...newMessages, { role: 'assistant', content: response.choices[0].message.content }];
        await api.saveHistory(sessionId, updatedMessages);
        setMessages(updatedMessages);
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
          <Picker.Item label="gpt-4o" value="gpt-4o" />
          <Picker.Item label="claude-3-5-sonnet" value="claude-3-5-sonnet" />
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
