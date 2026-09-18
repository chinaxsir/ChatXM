import React, { useState, useCallback, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView, Platform, SafeAreaView, Modal, Alert, Image, Pressable, Animated } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useThemeMode } from '@/hooks/useThemeMode';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { useAudioRecorder, useAudioRecorderState, AudioModule, RecordingPresets, setAudioModeAsync, createAudioPlayer } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';
import * as Clipboard from 'expo-clipboard';
import Markdown from 'react-native-markdown-display';
import { Ionicons } from '@expo/vector-icons';
import LoginScreen from './login';

const BUILTIN_ENDPOINT = 'https://api.frapi.kdns.fr';

// 录音文件 URI → data URL：真机读 m4a 转 base64；Web 端录音产物为 blob: URL，用 fetch+FileReader 转换
async function uriToAudioDataUrl(uri: string): Promise<string> {
  if (Platform.OS === 'web') {
    const blob = await fetch(uri).then(r => r.blob());
    return await new Promise<string>((resolve, reject) => {
      const reader = new (globalThis as any).FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('音频读取失败'));
      reader.readAsDataURL(blob);
    });
  }
  const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  return `data:audio/m4a;base64,${base64}`;
}

type Msg = {
  role: string;
  content: string;          // 完整内容（含附件），用于 API 请求和历史持久化
  displayContent?: string;  // 展示用的简短内容（仅用户输入文字），用于 UI 气泡
  image?: string | null;
  fileName?: string | null;
  audio?: string | null;    // 音频附件（base64 data URL）
  audioDuration?: number;   // 音频时长（秒）
};

const palettes = {
  light: { bg: '#F5F6F8', headerBg: '#FFFFFF', border: '#E5E5EA', sub: '#8E8E93', btnBg: '#F0F2F5', btnText: '#333333', accent: '#007AFF', accentSoft: '#E8F1FF', inputBg: '#F0F0F0', aiBubble: '#E9E9EB', aiText: '#000000', panelBg: '#FFFFFF', danger: '#E53E3E', chip: '#E8F1FF' },
  dark: { bg: '#000000', headerBg: '#1C1C1E', border: '#2C2C2E', sub: '#8E8E93', btnBg: '#2C2C2E', btnText: '#E5E5EA', accent: '#0A84FF', accentSoft: '#1A3A5C', inputBg: '#1C1C1E', aiBubble: '#2C2C2E', aiText: '#FFFFFF', panelBg: '#1C1C1E', danger: '#FF6B6B', chip: '#1A3A5C' },
};

export default function ChatScreen() {
  const { scheme } = useThemeMode();
  const C = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const [config, setConfig] = useState<any>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sessionId, setSessionId] = useState('default_session');
  const [input, setInput] = useState('');
  const [model, setModel] = useState('frapi');
  const [image, setImage] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [showImageSrc, setShowImageSrc] = useState(false);
  const [actionIdx, setActionIdx] = useState<number | null>(null);
  const [searchKw, setSearchKw] = useState('');
  // 音频直传模式（expo-audio）
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);
  const recording = recorderState.isRecording;
  const recordDuration = Math.floor(recorderState.durationMillis / 1000);
  const [audioPreview, setAudioPreview] = useState<string | null>(null); // 待发送的录音 base64
  const [recordedDuration, setRecordedDuration] = useState(0); // 已完成录音的时长（秒）
  const playingPlayerRef = useRef<AudioPlayer | null>(null);
  const [playingAudioIdx, setPlayingAudioIdx] = useState<number | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const listRef = useRef<FlatList<Msg>>(null);
  const router = useRouter();
  // 流式输出相关 ref
  const aiTextRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiMsgKeyRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  // 思考中三点动画
  const dotAnims = useRef([new Animated.Value(0.3), new Animated.Value(0.3), new Animated.Value(0.3)]).current;

  useEffect(() => {
    if (!sending) return;
    const loops = dotAnims.map((v, i) =>
      Animated.loop(Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 400, delay: i * 150, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.3, duration: 400, useNativeDriver: true }),
      ]))
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [sending, dotAnims]);

  // 组件卸载时释放音频播放器
  useEffect(() => {
    return () => {
      if (playingPlayerRef.current) {
        try { playingPlayerRef.current.remove(); } catch {}
        playingPlayerRef.current = null;
      }
    };
  }, []);

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
    setFileName(null);
    setFileContent(null);
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
      if (perm.status !== 'granted') { Alert.alert('Frapi AI', '需要授权访问' + (useCamera ? '相机' : '相册')); return; }

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
      Alert.alert('Frapi AI', '获取图片失败: ' + (e?.message || e));
    }
  };

  // 图片按钮统一入口：真机弹出「拍照 / 相册」选择，Web 直接打开相册
  const onPressImage = () => {
    if (Platform.OS === 'web') {
      pickImage(false);
    } else {
      setShowImageSrc(true);
    }
  };

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'text/plain', 'application/pdf', 'application/json', 'text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      const mime = file.mimeType || '';
      if (mime.startsWith('image/')) {
        // 图片走图片通道
        let dataUrl = '';
        try {
          const rendered = await ImageManipulator.manipulate(file.uri).resize({ width: 1024 }).renderAsync();
          const saved = await rendered.saveAsync({ compress: 0.6, format: SaveFormat.JPEG, base64: true });
          dataUrl = `data:image/jpeg;base64,${saved.base64}`;
        } catch {
          dataUrl = file.uri;
        }
        setImage(dataUrl);
      } else {
        // 文本类文件：读取内容
        const textExts = ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.css', '.html', '.xml', '.yaml', '.yml', '.sh', '.log', '.ini', '.conf', '.env', '.csv', '.sql', '.dart', '.kt', '.swift', '.rb', '.php'];
        const isText = textExts.some(ext => file.name.toLowerCase().endsWith(ext)) || mime.startsWith('text/');
        let content = '';
        let readError = '';
        if (isText) {
          try {
            content = await readAsStringAsync(file.uri, { encoding: EncodingType.UTF8 });
          } catch (e: any) {
            readError = e?.message || String(e);
          }
        } else {
          readError = '不支持的文件类型（仅支持文本类文件，如 .txt/.md/.json/.py 等）';
        }

        // 读取失败或内容为空时显式提示，避免 AI 收到空内容
        if (!content.trim()) {
          Alert.alert(
            'Frapi AI',
            readError
              ? `文件内容读取失败：${readError}`
              : `文件「${file.name}」内容为空，AI 将无法读取其内容`
          );
          return;
        }

        // 大文件截断（避免超出模型上下文），约 12000 字符
        const MAX_LEN = 12000;
        let finalContent = content;
        let truncatedNotice = '';
        if (content.length > MAX_LEN) {
          finalContent = content.slice(0, MAX_LEN);
          truncatedNotice = `\n（注：文件过大，已截断至前 ${MAX_LEN} 字符，完整内容请分段上传）`;
        }

        setFileName(file.name);
        setFileContent(finalContent + truncatedNotice);
      }
    } catch (e: any) {
      Alert.alert('Frapi AI', '选择文件失败: ' + (e?.message || e));
    }
  };

  const resolveTarget = () => {
    if (model.startsWith('tp:')) {
      const [, idxStr, ...rest] = model.split(':');
      const tp = config?.third_party_apis?.[Number(idxStr)];
      if (tp) return { endpoint: tp.endpoint, token: tp.apiKey, model: rest.join(':') };
    }
    return { endpoint: config?.builtin_endpoint || BUILTIN_ENDPOINT, token: config?.primary_api_key || config?.api_keys?.[0] || '', model };
  };

  // 组装最终提示文本（含文件内容）——用明确分隔符包裹，避免 AI 忽略附件内容
  const buildPrompt = () => {
    let prompt = input;
    if (fileName && fileContent) {
      const fileBlock = `\n\n--- 附件文件: ${fileName} ---\n${fileContent}\n--- 附件文件结束 ---\n`;
      prompt = prompt ? `${prompt}${fileBlock}` : fileBlock.trim();
    }
    return prompt;
  };

  const sendMessage = async () => {
    if (sending) return;
    if (!input.trim() && !image && !fileName && !audioPreview) return;
    if (!config) return;

    // 余额检查：新注册用户有 $1 额度，余额耗尽则拦截
    const balance = Number(config.balance ?? 0);
    if (config.balance != null && balance <= 0) {
      Alert.alert('Frapi AI', '余额不足，请前往「设置」充值后继续使用');
      return;
    }

    const target = resolveTarget();
    if (!target.token) {
      Alert.alert('Frapi AI', '未配置 API Key，请重新登录或在设置中添加 API');
      return;
    }

    const promptText = buildPrompt();
    // 纯音频消息（无文字）时给一个默认提示
    const displayText = input.trim() || (audioPreview ? '[语音消息]' : '');
    const userMsg: Msg = { role: 'user', content: promptText, displayContent: displayText, image, fileName, audio: audioPreview, audioDuration: recordedDuration };
    const aiMsgKey = 'ai_' + Date.now();
    const aiMsg: Msg = { role: 'assistant', content: '' };
    const newMessages = [...messages, userMsg, aiMsg];
    aiMsgKeyRef.current = aiMsgKey;
    aiTextRef.current = '';
    setMessages(newMessages);
    setInput('');
    setImage(null);
    setFileName(null);
    setFileContent(null);
    setAudioPreview(null);
    setRecordedDuration(0);
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // 节流 flush：累积文本后每 50ms 更新一次 UI，避免高频 setState
    const flush = () => {
      setMessages(prev => {
        const idx = prev.length - 1;
        if (idx < 0) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], content: aiTextRef.current };
        return updated;
      });
    };
    const scheduleFlush = () => {
      if (flushTimerRef.current) return;
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        flush();
      }, 50);
    };

    try {
      await api.sendChatStream(
        {
          endpoint: target.endpoint,
          token: target.token,
          model: target.model,
          prompt: promptText,
          image: image || undefined,
          audio: audioPreview || undefined,
          history: JSON.stringify(messages),
        },
        (delta) => {
          aiTextRef.current += delta;
          scheduleFlush();
        },
        async (usage) => {
          // 最终 flush
          if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
          flush();

          let total = usage?.total_tokens ?? (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
          // 兜底：后端未返回 usage 时，按回复字符数估算 tokens（中文约1字1token，英文约4字符1token）
          if (total === 0 && aiTextRef.current) {
            const text = aiTextRef.current;
            const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
            const others = text.length - chinese;
            const estCompletion = chinese + Math.ceil(others / 4);
            const estPrompt = Math.ceil((promptText.length) / 3);
            total = estPrompt + estCompletion;
          }
          // 保存历史
          const finalMessages = [...newMessages];
          finalMessages[finalMessages.length - 1] = { role: 'assistant', content: aiTextRef.current };
          await api.saveHistory(sessionId, finalMessages);

          // 累计消耗统计 + 本地估算扣费
          const day = new Date().toISOString().slice(0, 10);
          const u = config.usage || { total: 0, prompt: 0, completion: 0, count: 0, daily: {} as any };
          const d = u.daily[day] || { tokens: 0, count: 0 };
          // 估算扣费金额（按综合 $2 / 1M tokens 估算，仅本地即时反馈，最终以服务端为准）
          const estimatedCost = total * 0.000002;
          const newBalance = config.balance != null ? Math.max(0, Number(config.balance) - estimatedCost) : config.balance;
          const newConfig = {
            ...config,
            balance: newBalance,
            usage: {
              total: (u.total || 0) + total,
              prompt: (u.prompt || 0) + (usage?.prompt_tokens || 0),
              completion: (u.completion || 0) + (usage?.completion_tokens || 0),
              count: (u.count || 0) + 1,
              daily: { ...u.daily, [day]: { tokens: d.tokens + total, count: d.count + 1 } },
            },
          };
          await api.saveConfig(newConfig);
          setConfig(newConfig);

          // 同步服务端真实余额
          if (config.session_token) {
            try {
              const r = await api.refreshAccount(config.session_token);
              const realBalance = r?.data?.balance ?? r?.balance ?? r?.data?.user?.balance;
              if (realBalance != null) {
                const synced = { ...newConfig, balance: realBalance };
                await api.saveConfig(synced);
                setConfig(synced);
              }
            } catch { /* 同步失败时保留本地估算值 */ }
          }
          abortRef.current = null;
        },
        controller.signal
      );
    } catch (e: any) {
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      const aborted = e?.name === 'AbortError' || abortRef.current?.signal.aborted;
      abortRef.current = null;
      const partial = aiTextRef.current;
      if (partial) {
        const finalMessages = [...newMessages];
        finalMessages[finalMessages.length - 1] = { role: 'assistant', content: partial };
        await api.saveHistory(sessionId, finalMessages);
      } else {
        setMessages(prev => prev.slice(0, -1));
      }
      if (!aborted) {
        Alert.alert('Frapi AI', '对话请求失败: ' + (e?.message || e));
        console.error(e);
      }
    } finally {
      setSending(false);
    }
  };

  const stopStreaming = () => { if (abortRef.current) abortRef.current.abort(); };

  const closeAction = () => setActionIdx(null);
  const copyMsg = async () => {
    if (actionIdx == null) return;
    const m = messages[actionIdx];
    const text = m?.displayContent || m?.content || '';
    await Clipboard.setStringAsync(text);
    closeAction();
  };
  const editMsg = () => {
    if (actionIdx == null) return;
    const m = messages[actionIdx];
    if (m?.role === 'user' && m.content) {
      setInput(m.displayContent || m.content);
      setActionIdx(null);
    }
  };
  const deleteMsg = () => {
    if (actionIdx == null) return;
    const updated = messages.filter((_, i) => i !== actionIdx);
    setMessages(updated);
    api.saveHistory(sessionId, updated);
    setActionIdx(null);
  };

  // 导出当前会话为文本
  const exportSession = async () => {
    if (messages.length === 0) { Alert.alert('Frapi AI', '当前会话无内容可导出'); return; }
    const text = messages.map(m => {
      const role = m.role === 'user' ? '我' : 'AI';
      return `[${role}]\n${m.displayContent || m.content}`;
    }).join('\n\n');
    const full = `Frapi AI 会话导出\n时间: ${new Date().toLocaleString()}\n模型: ${model === 'frapi' ? '官方 API' : model}\n\n${text}`;
    await Clipboard.setStringAsync(full);
    Alert.alert('Frapi AI', '会话内容已复制到剪贴板，可粘贴到任意位置保存');
  };

  // ========== 语音输入（音频直传，按住麦克风录音，松开发送） ==========
  const startRecording = async () => {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) { Alert.alert('Frapi AI', '需要麦克风权限'); return; }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await audioRecorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
      audioRecorder.record();
    } catch (e: any) {
      Alert.alert('Frapi AI', '录音启动失败: ' + (e?.message || e));
    }
  };

  // 松开停止录音并转 base64
  const stopRecording = async () => {
    if (!audioRecorder.isRecording) return;
    try {
      // 停止前记录时长（秒）
      const duration = Math.floor(audioRecorder.currentTime || 0);
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) {
        Alert.alert('Frapi AI', '录音文件未生成，请重试');
        return;
      }
      // 时长不足 1 秒提示
      if (duration < 1) {
        Alert.alert('Frapi AI', '录音时间过短，请长按麦克风重新录制');
        return;
      }
      // 读取音频文件转 data URL（真机 m4a base64；Web 为 blob 转 dataURL）
      const dataUrl = await uriToAudioDataUrl(uri);
      setRecordedDuration(duration);
      setAudioPreview(dataUrl);
    } catch (e: any) {
      Alert.alert('Frapi AI', '录音处理失败: ' + (e?.message || e));
    }
  };

  // 播放/停止消息中的音频
  const togglePlayAudio = (idx: number, audioUrl: string) => {
    // 如果正在播放同一条，停止
    if (playingAudioIdx === idx && playingPlayerRef.current) {
      try { playingPlayerRef.current.remove(); } catch {}
      playingPlayerRef.current = null;
      setPlayingAudioIdx(null);
      return;
    }
    // 停止之前正在播放的
    if (playingPlayerRef.current) {
      try { playingPlayerRef.current.remove(); } catch {}
      playingPlayerRef.current = null;
    }
    try {
      const player = createAudioPlayer({ uri: audioUrl });
      playingPlayerRef.current = player;
      setPlayingAudioIdx(idx);
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) {
          playingPlayerRef.current = null;
          setPlayingAudioIdx(null);
        }
      });
      player.play();
    } catch (e: any) {
      Alert.alert('Frapi AI', '音频播放失败: ' + (e?.message || e));
      playingPlayerRef.current = null;
      setPlayingAudioIdx(null);
    }
  };

  // 格式化时长 mm:ss
  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const handleLoginSuccess = async () => {
    const c = await api.loadConfig();
    setConfig(c);
  };

  if (!config) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  const thirdPartyModels: { label: string; value: string }[] = [];
  (config?.third_party_apis || []).forEach((tp: any, idx: number) => {
    (tp.models || []).forEach((m: string) => {
      thirdPartyModels.push({ label: `${tp.name || 'API'} · ${m}`, value: `tp:${idx}:${m}` });
    });
  });

  const currentLabel = model === 'frapi' ? '官方 API' : (thirdPartyModels.find(m => m.value === model)?.label || '官方 API');

  // 是否有可发送内容（文字 / 图片 / 文件 / 待发送语音）
  const hasContent = !!(input.trim() || image || fileName || audioPreview);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: C.bg }]}>
      {/* 顶栏：历史 | 模型选择 | 新对话 | 对话/设置 切换 */}
      <View style={[styles.header, { backgroundColor: C.headerBg, borderBottomColor: C.border }]}>
        <Pressable style={({ pressed }) => [styles.iconBtn, { backgroundColor: C.btnBg }, pressed && { opacity: 0.6, transform: [{ scale: 0.92 }] }]} onPress={() => { loadSessions(); setShowHistory(true); }}>
          <Text style={[styles.iconBtnText, { color: C.btnText }]}>☰</Text>
        </Pressable>

        {/* 模型选择：胶囊，收窄宽度 */}
        <Pressable
          style={({ pressed }) => [
            styles.modelChip,
            { backgroundColor: thirdPartyModels.length > 0 ? C.chip : C.btnBg },
            thirdPartyModels.length > 0 && pressed && { opacity: 0.7, transform: [{ scale: 0.96 }] },
          ]}
          onPress={() => thirdPartyModels.length > 0 ? setShowModel(true) : null}
        >
          <ThemedText style={[styles.modelChipText, { color: thirdPartyModels.length > 0 ? C.accent : C.btnText }]} numberOfLines={1}>
            {currentLabel}
          </ThemedText>
          {thirdPartyModels.length > 0 && <Text style={[styles.chevron, { color: C.accent }]}>▾</Text>}
        </Pressable>

        <Pressable style={({ pressed }) => [styles.iconBtn, { backgroundColor: C.accentSoft }, pressed && { opacity: 0.7, transform: [{ scale: 0.92 }] }]} onPress={newChat}>
          <Text style={[styles.iconBtnText, { color: C.accent, fontWeight: '700' }]}>＋</Text>
        </Pressable>

        {/* 对话/设置 分段切换 */}
        <View style={[styles.segment, { backgroundColor: C.btnBg }]}>
          <View style={[styles.segItem, { backgroundColor: C.accent }]}>
            <ThemedText style={styles.segActiveText}>对话</ThemedText>
          </View>
          <Pressable style={({ pressed }) => [styles.segItem, pressed && { opacity: 0.6 }]} onPress={() => router.replace('/settings')}>
            <ThemedText style={{ color: C.btnText }}>设置</ThemedText>
          </Pressable>
        </View>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.content}>
        {messages.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={[styles.emptyLogo, { backgroundColor: C.accent }]}>
              <Text style={styles.emptyLogoText}>AI</Text>
            </View>
            <ThemedText style={[styles.emptyTitle, { color: C.btnText }]}>你好，我是 Frapi AI</ThemedText>
            <ThemedText style={[styles.emptySubtitle, { color: C.sub }]}>随时为你提供智能对话服务</ThemedText>
            <View style={styles.emptyChips}>
              {['帮我写一段代码', '解释一下这个概念', '翻译这段话', '帮我润色文案'].map((q) => (
                <TouchableOpacity
                  key={q}
                  style={[styles.emptyChip, { backgroundColor: C.btnBg, borderColor: C.border }]}
                  onPress={() => { setInput(q); }}
                  activeOpacity={0.7}
                >
                  <ThemedText style={[styles.emptyChipText, { color: C.btnText }]}>{q}</ThemedText>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(_, index) => index.toString()}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            renderItem={({ item, index }) => (
              <TouchableOpacity
                onLongPress={() => setActionIdx(index)}
                activeOpacity={0.7}
              >
              <View style={[styles.msgBubble, item.role === 'user'
                ? { backgroundColor: C.accent, alignSelf: 'flex-end' }
                : { backgroundColor: C.aiBubble, alignSelf: 'flex-start' }]}>
                {!!item.fileName && (
                  <View style={styles.fileBadge}>
                    <Text style={styles.fileIcon}>📎</Text>
                    <ThemedText style={[styles.fileName, { color: item.role === 'user' ? '#FFF' : C.aiText }]} numberOfLines={1}>{item.fileName}</ThemedText>
                  </View>
                )}
                {!!item.image && <Image source={{ uri: item.image }} style={styles.msgImage} resizeMode="cover" />}
                {!!item.audio && (
                  <Pressable
                    style={[styles.audioBubble, { backgroundColor: item.role === 'user' ? 'rgba(255,255,255,0.2)' : C.inputBg }]}
                    onPress={() => togglePlayAudio(index, item.audio!)}
                  >
                    <Ionicons
                      name={playingAudioIdx === index ? 'pause' : 'play'}
                      size={18}
                      color={item.role === 'user' ? '#FFF' : C.accent}
                    />
                    <View style={styles.audioWave}>
                      {[...Array(5)].map((_, i) => (
                        <View key={i} style={[styles.audioWaveBar, {
                          backgroundColor: item.role === 'user' ? 'rgba(255,255,255,0.6)' : C.sub,
                          height: 8 + (i % 3) * 4,
                        }]} />
                      ))}
                    </View>
                    <ThemedText style={[styles.audioDuration, { color: item.role === 'user' ? '#FFF' : C.sub }]}>
                      {formatDuration(item.audioDuration || 0)}
                    </ThemedText>
                  </Pressable>
                )}
                {!!item.content && (
                  item.role === 'assistant' ? (
                    <Markdown
                      style={{
                        body: { color: C.aiText, fontSize: 15, lineHeight: 21 },
                        code_inline: { backgroundColor: C.inputBg, color: C.aiText, paddingHorizontal: 4, borderRadius: 4, fontSize: 13 },
                        code_block: { backgroundColor: C.inputBg, color: C.aiText, padding: 10, borderRadius: 8, fontSize: 13 },
                        fence: { backgroundColor: C.inputBg, color: C.aiText, padding: 10, borderRadius: 8 },
                        paragraph: { marginVertical: 4 },
                        heading1: { color: C.aiText, fontSize: 20, fontWeight: '700', marginVertical: 6 },
                        heading2: { color: C.aiText, fontSize: 17, fontWeight: '700', marginVertical: 5 },
                        heading3: { color: C.aiText, fontSize: 15, fontWeight: '600', marginVertical: 4 },
                        list: { marginVertical: 4 },
                        bullet_list: { marginVertical: 4 },
                        ordered_list: { marginVertical: 4 },
                        list_item: { color: C.aiText, marginVertical: 2 },
                        blockquote: { borderLeftWidth: 3, borderLeftColor: C.accent, paddingLeft: 10, color: C.sub, marginVertical: 4 },
                        link: { color: C.accent },
                        hr: { backgroundColor: C.border, height: 1, marginVertical: 8 },
                        table: { borderWidth: 1, borderColor: C.border, marginVertical: 6 },
                        th: { backgroundColor: C.inputBg, color: C.aiText, padding: 6, fontWeight: '600' },
                        td: { color: C.aiText, padding: 6, borderTopWidth: 1, borderTopColor: C.border },
                      }}
                    >
                      {item.content}
                    </Markdown>
                  ) : (
                    <ThemedText style={[styles.msgText, { color: '#FFFFFF' }]}>
                      {item.displayContent || item.content}
                    </ThemedText>
                  )
                )}
                {!item.content && item.role === 'assistant' && sending && (
                  <View style={styles.thinking}>
                    <Animated.View style={[styles.thinkDot, { backgroundColor: C.accent, opacity: dotAnims[0] }]} />
                    <Animated.View style={[styles.thinkDot, { backgroundColor: C.accent, opacity: dotAnims[1] }]} />
                    <Animated.View style={[styles.thinkDot, { backgroundColor: C.accent, opacity: dotAnims[2] }]} />
                    <ThemedText style={[styles.thinkText, { color: C.sub }]}>思考中…</ThemedText>
                  </View>
                )}
              </View>
              </TouchableOpacity>
            )}
          />
        )}

        {/* 录音中状态提示 */}
        {recording && (
          <View style={[styles.recordingTip, { backgroundColor: C.accentSoft }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="mic" size={16} color={C.danger} />
              <Text style={{ color: C.danger, fontSize: 14 }}>录音中 {formatDuration(recordDuration)}</Text>
            </View>
            <ThemedText style={{ color: C.sub, fontSize: 12 }}>松开手指发送语音</ThemedText>
          </View>
        )}

        {/* 待发送附件预览 */}
        {(image || fileName || audioPreview) && (
          <View style={[styles.previewBar, { backgroundColor: C.headerBg }]}>
            {!!image && (
              <View style={styles.previewItem}>
                <Image source={{ uri: image }} style={styles.previewThumb} resizeMode="cover" />
                <TouchableOpacity style={styles.previewRemove} onPress={() => setImage(null)}>
                  <Text style={styles.previewRemoveText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
            {!!fileName && (
              <View style={[styles.filePreview, { backgroundColor: C.inputBg }]}>
                <Text style={styles.fileIcon}>📄</Text>
                <ThemedText style={[styles.fileName, { color: C.aiText, flex: 1 }]} numberOfLines={1}>{fileName}</ThemedText>
                <TouchableOpacity onPress={() => { setFileName(null); setFileContent(null); }}>
                  <Text style={{ color: C.danger }}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
            {!!audioPreview && (
              <View style={[styles.audioPreview, { backgroundColor: C.inputBg }]}>
                <Ionicons name="mic-circle" size={22} color={C.accent} />
                <ThemedText style={[styles.fileName, { color: C.aiText }]}>语音消息</ThemedText>
                <ThemedText style={{ color: C.sub, fontSize: 12 }}>{formatDuration(recordedDuration)}</ThemedText>
                <TouchableOpacity onPress={() => { setAudioPreview(null); setRecordedDuration(0); }} style={{ marginLeft: 8 }}>
                  <Text style={{ color: C.danger }}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* 输入区：图片 | 文件 | 输入框 | 麦克风/发送/停止 */}
        <View style={[styles.inputBar, { backgroundColor: C.headerBg, borderTopColor: C.border }]}>
          <Pressable
            style={({ pressed }) => [styles.iconCircle, { backgroundColor: C.btnBg }, pressed && { opacity: 0.5 }]}
            onPress={onPressImage}
            hitSlop={4}
          >
            <Ionicons name="image-outline" size={21} color={C.btnText} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.iconCircle, { backgroundColor: C.btnBg }, pressed && { opacity: 0.5 }]}
            onPress={pickFile}
            hitSlop={4}
          >
            <Ionicons name="document-text-outline" size={21} color={C.btnText} />
          </Pressable>
          <TextInput
            style={[styles.input, { backgroundColor: C.inputBg, color: C.aiText }]}
            value={input}
            onChangeText={setInput}
            placeholder="输入消息..."
            placeholderTextColor={C.sub}
            multiline
          />
          {sending ? (
            <Pressable
              style={({ pressed }) => [styles.actionCircle, { backgroundColor: C.danger }, pressed && { opacity: 0.8 }]}
              onPress={stopStreaming}
            >
              <Ionicons name="stop" size={18} color="#FFF" />
            </Pressable>
          ) : hasContent ? (
            <Pressable
              style={({ pressed }) => [styles.actionCircle, { backgroundColor: C.accent }, pressed && { opacity: 0.8, transform: [{ scale: 0.92 }] }]}
              onPress={sendMessage}
            >
              <Ionicons name="arrow-up" size={22} color="#FFF" />
            </Pressable>
          ) : (
            <Pressable
              style={[
                styles.actionCircle,
                { backgroundColor: recording ? C.danger : C.btnBg },
              ]}
              onPressIn={startRecording}
              onPressOut={stopRecording}
              hitSlop={4}
            >
              <Ionicons name="mic" size={21} color={recording ? '#FFF' : C.btnText} />
              {recording && (
                <View style={[styles.recordBadge, { backgroundColor: C.danger, borderColor: C.headerBg }]}>
                  <ThemedText style={styles.recordBadgeText}>{formatDuration(recordDuration)}</ThemedText>
                </View>
              )}
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* 历史会话面板 */}
      <Modal visible={showHistory} animationType="slide" transparent onRequestClose={() => { setShowHistory(false); setSearchKw(''); }}>
        <View style={styles.modalMask}>
          <View style={[styles.bottomPanel, { backgroundColor: C.panelBg }]}>
            <View style={styles.panelHeader}>
              <ThemedText type="subtitle">历史会话</ThemedText>
              <View style={{ flexDirection: 'row', gap: 16 }}>
                <TouchableOpacity onPress={exportSession}><ThemedText style={{ color: C.accent }}>导出</ThemedText></TouchableOpacity>
                <TouchableOpacity onPress={newChat}><ThemedText style={{ color: C.accent }}>＋ 新对话</ThemedText></TouchableOpacity>
                <TouchableOpacity onPress={() => { setShowHistory(false); setSearchKw(''); }}><ThemedText style={{ color: C.sub }}>关闭</ThemedText></TouchableOpacity>
              </View>
            </View>
            <TextInput
              style={[styles.searchInput, { backgroundColor: C.inputBg, color: C.aiText }]}
              placeholder="搜索会话..."
              placeholderTextColor={C.sub}
              value={searchKw}
              onChangeText={setSearchKw}
            />
            {(() => {
              const filtered = searchKw
                ? sessions.filter((s: any) => (s.title || '').toLowerCase().includes(searchKw.toLowerCase()))
                : sessions;
              if (filtered.length === 0) return <ThemedText style={{ color: C.sub, padding: 16 }}>无匹配会话</ThemedText>;
              return (
                <FlatList
                  data={filtered}
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
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* 模型选择面板 */}
      <Modal visible={showModel} animationType="slide" transparent onRequestClose={() => setShowModel(false)}>
        <View style={styles.modalMask}>
          <View style={[styles.bottomPanel, { backgroundColor: C.panelBg }]}>
            <View style={styles.panelHeader}>
              <ThemedText type="subtitle">选择模型</ThemedText>
              <TouchableOpacity onPress={() => setShowModel(false)}><ThemedText style={{ color: C.sub }}>关闭</ThemedText></TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.modelOption, { borderBottomColor: C.border }, model === 'frapi' && { backgroundColor: C.chip }]}
              onPress={() => { setModel('frapi'); setShowModel(false); }}
            >
              <ThemedText style={{ fontWeight: model === 'frapi' ? '600' : '400' }}>官方 API</ThemedText>
              {model === 'frapi' && <ThemedText style={{ color: C.accent }}>✓</ThemedText>}
            </TouchableOpacity>
            {thirdPartyModels.map(m => (
              <TouchableOpacity
                key={m.value}
                style={[styles.modelOption, { borderBottomColor: C.border }, model === m.value && { backgroundColor: C.chip }]}
                onPress={() => { setModel(m.value); setShowModel(false); }}
              >
                <ThemedText style={{ fontWeight: model === m.value ? '600' : '400' }}>{m.label}</ThemedText>
                {model === m.value && <ThemedText style={{ color: C.accent }}>✓</ThemedText>}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>

      {/* 图片来源选择 ActionSheet：拍照 / 相册 */}
      <Modal visible={showImageSrc} animationType="fade" transparent onRequestClose={() => setShowImageSrc(false)}>
        <TouchableOpacity style={styles.modalMask} onPress={() => setShowImageSrc(false)} activeOpacity={1}>
          <View style={[styles.actionSheet, { backgroundColor: C.panelBg }]}>
            <TouchableOpacity
              style={[styles.actionItem, { borderBottomColor: C.border }]}
              onPress={() => { setShowImageSrc(false); pickImage(true); }}
            >
              <ThemedText>📷 拍照</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionItem, { borderBottomColor: C.border }]}
              onPress={() => { setShowImageSrc(false); pickImage(false); }}
            >
              <ThemedText>🖼️ 从相册选择</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: C.border }]} onPress={() => setShowImageSrc(false)}>
              <ThemedText style={{ color: C.sub }}>取消</ThemedText>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 消息操作 ActionSheet */}
      <Modal visible={actionIdx != null} animationType="fade" transparent onRequestClose={closeAction}>
        <TouchableOpacity style={styles.modalMask} onPress={closeAction} activeOpacity={1}>
          <View style={[styles.actionSheet, { backgroundColor: C.panelBg }]}>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: C.border }]} onPress={copyMsg}>
              <ThemedText>📋 复制内容</ThemedText>
            </TouchableOpacity>
            {messages[actionIdx ?? -1]?.role === 'user' && (
              <TouchableOpacity style={[styles.actionItem, { borderBottomColor: C.border }]} onPress={editMsg}>
                <ThemedText>✏️ 编辑重发</ThemedText>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: C.border }]} onPress={deleteMsg}>
              <ThemedText style={{ color: C.danger }}>🗑️ 删除消息</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderBottomColor: C.border }]} onPress={closeAction}>
              <ThemedText style={{ color: C.sub }}>取消</ThemedText>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, gap: 6 },
  iconBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  iconBtnText: { fontSize: 18, lineHeight: 20 },
  modelChip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 36, minWidth: 88, maxWidth: 130, borderRadius: 10, paddingHorizontal: 10, gap: 3 },
  modelChipText: { fontSize: 13, fontWeight: '500' },
  chevron: { fontSize: 11 },
  segment: { flexDirection: 'row', borderRadius: 9, padding: 2, marginLeft: 'auto' },
  segItem: { paddingHorizontal: 12, height: 32, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  segActiveText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24 },
  emptyLogo: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginTop: -20, elevation: 4, shadowColor: '#007AFF', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 8 },
  emptyLogoText: { color: '#FFF', fontSize: 22, fontWeight: '700', letterSpacing: 0.5 },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginTop: 8 },
  emptySubtitle: { fontSize: 13 },
  emptyChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 16 },
  emptyChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth },
  emptyChipText: { fontSize: 12 },
  listContent: { padding: 16 },
  msgBubble: { padding: 12, borderRadius: 18, marginVertical: 6, maxWidth: '85%' },
  msgImage: { width: 200, height: 200, borderRadius: 12, marginBottom: 6 },
  msgText: { fontSize: 15, lineHeight: 21 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  thinkDot: { width: 6, height: 6, borderRadius: 3 },
  thinkText: { fontSize: 13, marginLeft: 4 },
  fileBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  fileIcon: { fontSize: 16 },
  fileName: { fontSize: 13 },
  previewBar: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  previewItem: { position: 'relative' },
  previewThumb: { width: 64, height: 64, borderRadius: 8 },
  previewRemove: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: '#E53E3E', alignItems: 'center', justifyContent: 'center' },
  previewRemoveText: { color: '#FFF', fontSize: 11, lineHeight: 13 },
  filePreview: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, height: 44 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, gap: 6 },
  // 输入栏左侧附件圆形按钮（图片/文件）
  iconCircle: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', marginBottom: 2 },
  // 输入栏右侧动作圆形按钮（麦克风/发送/停止）
  actionCircle: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', marginBottom: 2 },
  input: { flex: 1, minHeight: 36, maxHeight: 100, borderRadius: 18, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8, fontSize: 16 },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  actionSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 8 },
  actionItem: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  bottomPanel: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, maxHeight: '70%' },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  searchInput: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 10, fontSize: 14 },
  sessionItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  modelOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  // 音频消息气泡
  audioBubble: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, gap: 10, minWidth: 120 },
  audioWave: { flexDirection: 'row', alignItems: 'center', gap: 2, flex: 1, marginLeft: 2 },
  audioWaveBar: { width: 3, borderRadius: 2 },
  audioDuration: { fontSize: 12 },
  // 录音徽章
  recordBadge: { position: 'absolute', top: -4, right: -10, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 6, minWidth: 32, alignItems: 'center', borderWidth: 1.5 },
  recordingTip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  recordBadgeText: { color: '#FFF', fontSize: 9, fontWeight: '600' },
  // 音频预览
  audioPreview: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 10, borderRadius: 10, minHeight: 44 },
});
