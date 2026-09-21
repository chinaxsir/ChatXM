import React, { useState, useCallback, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView, Platform, SafeAreaView, Modal, Alert, Image, Pressable, Animated, ScrollView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useThemeMode } from '@/hooks/useThemeMode';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { ThemedText } from '@/components/themed-text';
import { api } from '@/services/api';
import * as Clipboard from 'expo-clipboard';
import Markdown from 'react-native-markdown-display';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import LoginScreen from './login';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';

const BUILTIN_ENDPOINT = 'https://api.frapi.kdns.fr';

type Msg = {
  role: string;
  content: string;          // 完整内容（含附件），用于 API 请求和历史持久化
  displayContent?: string;  // 展示用的简短内容（仅用户输入文字），用于 UI 气泡
  image?: string | null;
  fileName?: string | null;
};

const palettes = {
  light: { bg: '#F5F6F8', headerBg: '#FFFFFF', border: '#E5E5EA', sub: '#8E8E93', btnBg: '#F0F2F5', btnText: '#333333', accent: '#007AFF', accentSoft: '#E8F1FF', inputBg: '#F0F0F0', aiBubble: '#E9E9EB', aiText: '#000000', panelBg: '#FFFFFF', danger: '#E53E3E', chip: '#E8F1FF' },
  dark: { bg: '#000000', headerBg: '#1C1C1E', border: '#2C2C2E', sub: '#8E8E93', btnBg: '#2C2C2E', btnText: '#E5E5EA', accent: '#0A84FF', accentSoft: '#1A3A5C', inputBg: '#1C1C1E', aiBubble: '#2C2C2E', aiText: '#FFFFFF', panelBg: '#1C1C1E', danger: '#FF6B6B', chip: '#1A3A5C' },
};

export default function ChatScreen() {
  const { scheme } = useThemeMode();
  const C = palettes[scheme === 'dark' ? 'dark' : 'light'];
  const [config, setConfig] = useState<any>(null);
  // configRef 始终指向最新配置：模型自动同步、余额扣费等异步任务写回时
  // 以此为基准展开，避免彼此用旧快照覆盖对方刚写入的字段（如 current_model/balance）
  const configRef = useRef<any>(null);
  const applyConfig = (next: any) => { configRef.current = next; setConfig(next); };
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
  // 端侧语音识别模式（expo-speech-recognition，完全调用系统原生识别，不经过API）
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recognizedText, setRecognizedText] = useState('');
  // 上滑取消状态、录音秒数（商业级按住说话交互）
  const [voiceCanceling, setVoiceCanceling] = useState(false);
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const recording = isTranscribing;
  // ref 保存最新识别文本，解决松手瞬间 state 尚未更新的时序问题
  const recognizedRef = useRef('');
  // 防止同一段语音被重复发送（final 事件 + 兜底定时器竞态）
  const voiceSendLockRef = useRef(false);
  // 手势与计时器 refs
  const voiceStartYRef = useRef<number | null>(null);
  const voiceCancelingRef = useRef(false);
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<TextInput>(null);
  // 录音声波动画（4 根跳动条）
  const waveAnims = useRef([...Array(4)].map(() => new Animated.Value(0.35))).current;

  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results[0]?.transcript;
    if (text) {
      recognizedRef.current = text;
      setRecognizedText(text);
      setInput(text);
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    setIsTranscribing(false);
    // no-speech / aborted 属于正常交互，静默处理
    if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') {
      Alert.alert('Frapi AI', '语音识别失败: ' + (event.message || event.error));
    }
  });

  useSpeechRecognitionEvent('end', () => {
    setIsTranscribing(false);
  });
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

  // 录音中声波跳动动画
  useEffect(() => {
    if (!recording) {
      waveAnims.forEach(v => v.setValue(0.35));
      return;
    }
    const loops = waveAnims.map((v, i) =>
      Animated.loop(Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 380, delay: i * 130, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.35, duration: 380, useNativeDriver: true }),
      ]))
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [recording, waveAnims]);

  // 卸载时清理语音计时器
  useEffect(() => () => { if (voiceTimerRef.current) clearInterval(voiceTimerRef.current); }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const c = await api.loadConfig();
        if (!active) return;
        applyConfig(c);
        if (c?.current_model) setModel(c.current_model);
        // 启动时自动同步第三方API模型列表（后台新增/改名智能模型组自动拉取）
        if (c) refreshThirdPartyModels(c);
        // 恢复上次退出时正在查看的会话，所有历史均保存在本地
        const lastId = await api.loadLastSession();
        if (active && lastId) setSessionId(lastId);
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
    const id = 's_' + Date.now().toString(36);
    setSessionId(id);
    api.saveLastSession(id);
    setMessages([]);
    setInput('');
    setImage(null);
    setFileName(null);
    setFileContent(null);
    setShowHistory(false);
  };

  const openSession = (id: string) => {
    setSessionId(id);
    api.saveLastSession(id);
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
      // 放开为移动端常用全格式：图片 / PDF / Office / 文本代码 / 压缩包等，再按类型分流
      const result = await DocumentPicker.getDocumentAsync({
        type: Platform.OS === 'ios' ? ['public.item'] : ['*/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      const mime = file.mimeType || '';
      const lowerName = file.name.toLowerCase();

      // 二进制办公/压缩类（端侧无法提取文本），给出明确商业提示而非静默失败
      const binaryExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.pages', '.numbers', '.key'];
      const isBinaryDoc = binaryExts.some(ext => lowerName.endsWith(ext))
        || ['application/pdf', 'application/zip', 'application/x-rar-compressed'].includes(mime)
        || mime.includes('officedocument') || mime.startsWith('application/msword');

      if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp'].some(ext => lowerName.endsWith(ext))) {
        // 图片统一走图片通道：压缩到 1024px 宽 / JPEG 60%
        let dataUrl = '';
        try {
          const rendered = await ImageManipulator.manipulate(file.uri).resize({ width: 1024 }).renderAsync();
          const saved = await rendered.saveAsync({ compress: 0.6, format: SaveFormat.JPEG, base64: true });
          dataUrl = `data:image/jpeg;base64,${saved.base64}`;
        } catch {
          dataUrl = file.uri;
        }
        setImage(dataUrl);
      } else if (isBinaryDoc) {
        Alert.alert(
          '暂不支持该文件格式',
          `「${file.name}」属于二进制文档，当前版本支持：\n• 图片（PNG/JPG/HEIC 等）\n• 文本与代码（TXT/MD/JSON/PY 等）\n\n建议将文档内容复制为文本，或截图后以图片发送。`
        );
      } else {
        // 文本类文件：读取内容
        const textExts = ['.txt', '.md', '.markdown', '.json', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.css', '.html', '.xml', '.yaml', '.yml', '.sh', '.log', '.ini', '.conf', '.env', '.csv', '.sql', '.dart', '.kt', '.swift', '.rb', '.php', '.vue', '.scss', '.less'];
        const isText = textExts.some(ext => lowerName.endsWith(ext)) || mime.startsWith('text/') || mime.includes('json') || mime.includes('xml');
        let content = '';
        let readError = '';
        if (isText) {
          try {
            content = await readAsStringAsync(file.uri, { encoding: EncodingType.UTF8 });
          } catch (e: any) {
            readError = e?.message || String(e);
          }
        } else {
          readError = '不支持的文件类型（支持图片，以及 .txt/.md/.json/.py 等文本与代码文件）';
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

  const sendMessage = async (overrideText?: string) => {
    if (sending || isTranscribing) return;
    const textToSend = typeof overrideText === 'string' ? overrideText : input;
    if (!textToSend.trim() && !image && !fileName) return;
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

    // 组装最终提示文本（含文件内容）
    let promptText = textToSend;
    if (fileName && fileContent) {
      const fileBlock = `\n\n--- 附件文件: ${fileName} ---\n${fileContent}\n--- 附件文件结束 ---\n`;
      promptText = promptText ? `${promptText}${fileBlock}` : fileBlock.trim();
    }

    const displayText = textToSend.trim();
    const userMsg: Msg = { role: 'user', content: promptText, displayContent: displayText, image, fileName };
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
          applyConfig(newConfig);

          // 同步服务端真实余额
          if (config.session_token) {
            try {
              const r = await api.refreshAccount(config.session_token);
              const realBalance = r?.data?.balance ?? r?.balance ?? r?.data?.user?.balance;
              if (realBalance != null) {
                const synced = { ...newConfig, balance: realBalance };
                await api.saveConfig(synced);
                applyConfig(synced);
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

  // ========== 语音输入（调用设备端侧原生语音识别，零 API 依赖） ==========
  const clearVoiceTimer = () => {
    if (voiceTimerRef.current) { clearInterval(voiceTimerRef.current); voiceTimerRef.current = null; }
  };

  // 按下：立即启动识别（单一主路径，不设点击/长按阈值，保证好按）
  const startRecording = async () => {
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Frapi AI', '需要麦克风与语音识别权限，请在系统设置中开启');
        return;
      }
      inputRef.current?.blur(); // 收起键盘，避免输入区高度跳动
      recognizedRef.current = '';
      voiceSendLockRef.current = false;
      voiceStartYRef.current = null;
      voiceCancelingRef.current = false;
      setVoiceCanceling(false);
      setVoiceSeconds(0);
      setRecognizedText('');
      setInput('');
      setIsTranscribing(true);
      ExpoSpeechRecognitionModule.start({
        lang: 'zh-CN',
        interimResults: true,
        continuous: false,
        addsPunctuation: true,
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      clearVoiceTimer();
      voiceTimerRef.current = setInterval(() => setVoiceSeconds(s => s + 1), 1000);
    } catch (e: any) {
      clearVoiceTimer();
      setIsTranscribing(false);
      Alert.alert('Frapi AI', '启动语音识别失败: ' + (e?.message || e));
    }
  };

  // 手指滑动追踪：上滑超过 70px 进入「取消发送」态
  const handleVoiceMove = (e: any) => {
    if (!isTranscribing) return;
    const y = e.nativeEvent?.pageY;
    if (typeof y !== 'number') return;
    if (voiceStartYRef.current == null) voiceStartYRef.current = y;
    const cancel = voiceStartYRef.current - y > 70;
    if (cancel !== voiceCancelingRef.current) {
      voiceCancelingRef.current = cancel;
      setVoiceCanceling(cancel);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  };

  const finishVoice = (canceled: boolean) => {
    clearVoiceTimer();
    try {
      if (canceled) {
        ExpoSpeechRecognitionModule.abort();
      } else {
        ExpoSpeechRecognitionModule.stop();
      }
    } catch {}

    if (canceled) {
      recognizedRef.current = '';
      setRecognizedText('');
      setInput('');
      setIsTranscribing(false);
      setVoiceCanceling(false);
      voiceCancelingRef.current = false;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }

    // iOS 在 stop() 后才会回调最终结果，延迟读取 ref 兜底；voiceSendLockRef 防止重复发送
    setTimeout(() => {
      if (voiceSendLockRef.current) return;
      const text = recognizedRef.current.trim();
      recognizedRef.current = '';
      setRecognizedText('');
      setIsTranscribing(false);
      setVoiceCanceling(false);
      voiceCancelingRef.current = false;
      if (text) {
        voiceSendLockRef.current = true;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        sendMessage(text);
        setTimeout(() => { voiceSendLockRef.current = false; }, 500);
      } else {
        setInput('');
      }
    }, 400);
  };

  // 松开：取消态 → 放弃；正常态 → 识别并自动发送
  const stopRecording = () => {
    if (!isTranscribing) return;
    finishVoice(voiceCancelingRef.current);
  };

  // 切换模型并持久化到本地配置，重启后保留选择
  const changeModel = async (m: string) => {
    setModel(m);
    setShowModel(false);
    if (config) {
      const updated = { ...config, current_model: m };
      await api.saveConfig(updated);
      applyConfig(updated);
    }
  };

  // 自动同步模型列表（APP启动时+打开模型面板时触发）
  // 第三方API：服务端 /v1/models 为权威来源，拉取失败静默降级保留本地快照；手动输入的模型(manual_models)始终保留
  // 官方智能模型组（池）：拉取 /v1/models 后用探测法自动识别组别名——
  //   对每个 id 发 max_tokens=1 极小请求，响应 model ≠ 请求 id 即被网关路由过 → 是组别名；
  //   仅当模型 id 列表发生变化时才重新探测（后台无调整则零探测成本），失败/为空保底 ['frapi']
  const refreshThirdPartyModels = async (baseConfig: any) => {
    const apis: any[] = [...(baseConfig?.third_party_apis || [])];
    let changed = false;
    // 官方智能模型组自动识别
    let officialGroups: string[] | null = null;
    let officialIds: string[] | null = null;
    const officialKey = baseConfig?.primary_api_key || baseConfig?.api_keys?.[0] || '';
    if (officialKey) {
      try {
        const res = await api.fetchModels(baseConfig?.builtin_endpoint || BUILTIN_ENDPOINT, officialKey);
        const ids: string[] = Array.from(new Set(res?.data?.map((m: any) => m.id).filter(Boolean) || []));
        if (ids.length > 0) {
          officialIds = ids;
          const prevIds: string[] = baseConfig?.official_model_ids || [];
          const prevGroups: string[] = baseConfig?.official_groups?.length ? baseConfig.official_groups : ['frapi'];
          if (JSON.stringify([...ids].sort()) === JSON.stringify([...prevIds].sort())) {
            officialGroups = prevGroups; // 列表未变化：复用缓存，零探测成本
          } else {
            const results = await Promise.all(ids.map((id) => api.probeGroupAlias(baseConfig?.builtin_endpoint || BUILTIN_ENDPOINT, officialKey, id)));
            const groups = ids.filter((_, i) => results[i] != null);
            // 探测全部失败（网络异常等）时保留缓存，避免清空可用组
            officialGroups = groups.length > 0 ? groups : prevGroups;
          }
          if (JSON.stringify(officialGroups) !== JSON.stringify(prevGroups)) changed = true;
          if (JSON.stringify(ids) !== JSON.stringify(prevIds)) changed = true;
        }
      } catch { /* 静默降级：保留缓存或默认 frapi */ }
    }
    if (apis.length > 0) await Promise.all(apis.map(async (tp: any, idx: number) => {
      if (!tp?.endpoint || !tp?.apiKey) return;
      try {
        const res = await api.fetchModels(tp.endpoint, tp.apiKey);
        const fetched: string[] = res?.data?.map((m: any) => m.id).filter(Boolean) || [];
        if (fetched.length > 0) {
          const merged = Array.from(new Set([...fetched, ...(tp.manual_models || [])]));
          if (JSON.stringify(merged) !== JSON.stringify(tp.models || [])) {
            apis[idx] = { ...tp, models: merged };
            changed = true;
          }
        }
      } catch { /* 静默降级：网络异常/临时故障时保留本地快照 */ }
    }));
    if (!changed) return;
    // 以 configRef 最新配置为基准写回：刷新期间用户可能已切换模型/产生扣费，
    // 用传入的 baseConfig 展开会把那些字段覆盖回旧值
    const latest = configRef.current || baseConfig;
    const updated: any = { ...latest, third_party_apis: apis };
    if (officialGroups != null) {
      updated.official_groups = officialGroups;
      if (officialIds != null) updated.official_model_ids = officialIds; // 记录探测基准，列表未变则下次跳过探测
    }
    // 当前选中的模型若已被删除/改名，自动回退，避免引用失效
    const groupsNow: string[] = updated.official_groups?.length ? updated.official_groups : ['frapi'];
    const cur = String(updated.current_model || '');
    if (cur.startsWith('tp:')) {
      const parts = cur.split(':');
      const idx = Number(parts[1]);
      const modelName = parts.slice(2).join(':');
      if (!apis[idx]?.models?.includes(modelName)) {
        updated.current_model = groupsNow[0] || 'frapi';
        setModel(groupsNow[0] || 'frapi');
      }
    } else if (!groupsNow.includes(cur)) {
      // 官方组被删除/改名 → 回退第一组
      updated.current_model = groupsNow[0] || 'frapi';
      setModel(groupsNow[0] || 'frapi');
    }
    applyConfig(updated);
    await api.saveConfig(updated);
  };

  const handleLoginSuccess = async () => {
    const c = await api.loadConfig();
    applyConfig(c);
    // 登录后首次进入：useFocusEffect 不会重新触发（页面未切换），此处主动同步一次模型列表
    if (c) refreshThirdPartyModels(c);
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

  // 官方智能模型组（池）：来自设置页手动配置（/v1/models 无法区分组名与真实模型），
  // 网关按组名自动路由到组内模型；默认保底 frapi
  const officialModels: string[] = (config?.official_groups?.length ? config.official_groups : ['frapi']) as string[];
  const isOfficialModel = (v: string) => officialModels.includes(v);

  // 顶栏胶囊固定显示「官方」，具体选哪个智能模型组在面板内选择（对用户透明）
  const currentLabel = isOfficialModel(model)
    ? '官方'
    : (thirdPartyModels.find(m => m.value === model)?.label || '官方');

  // 是否有可发送内容（文字 / 图片 / 文件）
  const hasContent = !!(input.trim() || image || fileName);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: C.bg }]}>
      {/* 顶栏：历史 | 模型选择 | 新对话 | 对话/设置 切换 */}
      <View style={[styles.header, { backgroundColor: C.headerBg, borderBottomColor: C.border }]}>
        <Pressable style={({ pressed }) => [styles.iconBtn, { backgroundColor: C.btnBg }, pressed && { opacity: 0.6, transform: [{ scale: 0.92 }] }]} onPress={() => { loadSessions(); setShowHistory(true); }}>
          <Text style={[styles.iconBtnText, { color: C.btnText }]}>☰</Text>
        </Pressable>

        {/* 模型选择：胶囊，收窄宽度（官方组始终可选，无需配置第三方API） */}
        <Pressable
          style={({ pressed }) => [
            styles.modelChip,
            { backgroundColor: C.chip },
            pressed && { opacity: 0.7, transform: [{ scale: 0.96 }] },
          ]}
          onPress={() => { setShowModel(true); if (config) refreshThirdPartyModels(config); }}
        >
          <ThemedText style={[styles.modelChipText, { color: C.accent }]} numberOfLines={1}>
            {currentLabel}
          </ThemedText>
          <Text style={[styles.chevron, { color: C.accent }]}>▾</Text>
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

        {/* 待发送附件预览 */}
        {(image || fileName) && (
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
          </View>
        )}

        {/* 输入区：图片 | 附件 | 输入框 | 麦克风/发送/停止 */}
        <View style={[styles.inputBar, { backgroundColor: C.headerBg, borderTopColor: C.border }]}>
          <Pressable
            style={({ pressed }) => [styles.iconCircle, { backgroundColor: C.btnBg }, pressed && { opacity: 0.5 }]}
            onPress={onPressImage}
            hitSlop={8}
          >
            <Ionicons name="image-outline" size={22} color={C.btnText} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.iconCircle, { backgroundColor: C.btnBg }, pressed && { opacity: 0.5 }]}
            onPress={pickFile}
            hitSlop={8}
          >
            <Ionicons name="attach-outline" size={23} color={C.btnText} />
          </Pressable>
          <TextInput
            ref={inputRef}
            style={[styles.input, { backgroundColor: C.inputBg, color: C.aiText }]}
            value={input}
            onChangeText={setInput}
            placeholder="输入消息..."
            placeholderTextColor={C.sub}
            multiline
          />
          {sending ? (
            <Pressable
              style={({ pressed }) => [styles.actionCircle, { backgroundColor: C.danger }, pressed && { opacity: 0.85, transform: [{ scale: 0.94 }] }]}
              onPress={stopStreaming}
              hitSlop={8}
            >
              <Ionicons name="stop" size={20} color="#FFF" />
            </Pressable>
          ) : hasContent ? (
            <Pressable
              style={({ pressed }) => [styles.actionCircle, { backgroundColor: C.accent }, pressed && { opacity: 0.85, transform: [{ scale: 0.92 }] }]}
              onPress={() => sendMessage()}
              hitSlop={8}
            >
              <Ionicons name="arrow-up" size={24} color="#FFF" />
            </Pressable>
          ) : (
            <Pressable
              style={({ pressed }) => [
                styles.actionCircle,
                {
                  backgroundColor: voiceCanceling ? C.sub : (recording ? C.danger : C.btnBg),
                  transform: [{ scale: recording ? 1.12 : (pressed ? 1.06 : 1) }],
                },
              ]}
              onPressIn={startRecording}
              onPressOut={stopRecording}
              onTouchMove={handleVoiceMove}
              hitSlop={8}
            >
              <Ionicons name={voiceCanceling ? 'trash-outline' : 'mic'} size={24} color={recording ? '#FFF' : C.btnText} />
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* 按住说话全屏浮层：声波 + 时长 + 实时文本 + 上滑取消 */}
      {recording && (
        <View style={styles.voiceOverlay} pointerEvents="none">
          <View style={[styles.voiceCard, { borderColor: voiceCanceling ? C.danger : 'rgba(255,255,255,0.12)' }]}>
            <View style={[styles.voiceMicCircle, { backgroundColor: voiceCanceling ? C.danger : 'rgba(255,255,255,0.14)' }]}>
              <Ionicons name={voiceCanceling ? 'trash-outline' : 'mic'} size={34} color="#FFF" />
            </View>
            <View style={styles.voiceWave}>
              {waveAnims.map((anim, i) => (
                <Animated.View
                  key={i}
                  style={[
                    styles.voiceWaveBar,
                    {
                      backgroundColor: voiceCanceling ? C.danger : '#0A84FF',
                      opacity: anim,
                      transform: [{ scaleY: anim.interpolate({ inputRange: [0.35, 1], outputRange: [0.5, 1.3] }) }],
                    },
                  ]}
                />
              ))}
            </View>
            <Text style={styles.voiceTime}>
              {String(Math.floor(voiceSeconds / 60)).padStart(2, '0')}:{String(voiceSeconds % 60).padStart(2, '0')}
            </Text>
            {!!recognizedText && (
              <Text style={styles.voicePreviewText} numberOfLines={3}>{recognizedText}</Text>
            )}
            <Text style={styles.voiceHint}>
              {voiceCanceling ? '松开手指，取消发送' : '松开手指，自动发送　·　上滑取消'}
            </Text>
          </View>
        </View>
      )}

      {/* 历史会话面板 */}
      <Modal visible={showHistory} animationType="slide" transparent onRequestClose={() => { setShowHistory(false); setSearchKw(''); }}>
        <TouchableOpacity style={styles.modalMask} onPress={() => { setShowHistory(false); setSearchKw(''); }} activeOpacity={1}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
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
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 模型选择面板 */}
      <Modal visible={showModel} animationType="slide" transparent onRequestClose={() => setShowModel(false)}>
        <TouchableOpacity style={styles.modalMask} onPress={() => setShowModel(false)} activeOpacity={1}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
          <View style={[styles.bottomPanel, { backgroundColor: C.panelBg }]}>
            <View style={styles.panelHeader}>
              <ThemedText type="subtitle">选择模型</ThemedText>
              <TouchableOpacity onPress={() => setShowModel(false)}><ThemedText style={{ color: C.sub }}>关闭</ThemedText></TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }} nestedScrollEnabled>
              <ThemedText style={{ color: C.sub, fontSize: 12, paddingVertical: 6 }}>官方</ThemedText>
              {officialModels.map(m => (
                <TouchableOpacity
                  key={`of-${m}`}
                  style={[styles.modelOption, { borderBottomColor: C.border }, model === m && { backgroundColor: C.chip }]}
                  onPress={() => changeModel(m)}
                >
                  <ThemedText style={{ fontWeight: model === m ? '600' : '400' }}>{m}</ThemedText>
                  {model === m && <ThemedText style={{ color: C.accent }}>✓</ThemedText>}
                </TouchableOpacity>
              ))}
              {thirdPartyModels.length > 0 && (
                <ThemedText style={{ color: C.sub, fontSize: 12, paddingVertical: 6 }}>第三方 API</ThemedText>
              )}
              {thirdPartyModels.map(m => (
                <TouchableOpacity
                  key={m.value}
                  style={[styles.modelOption, { borderBottomColor: C.border }, model === m.value && { backgroundColor: C.chip }]}
                  onPress={() => changeModel(m.value)}
                >
                  <ThemedText style={{ fontWeight: model === m.value ? '600' : '400' }}>{m.label}</ThemedText>
                  {model === m.value && <ThemedText style={{ color: C.accent }}>✓</ThemedText>}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 图片来源选择 ActionSheet：拍照 / 相册 */}
      <Modal visible={showImageSrc} animationType="fade" transparent onRequestClose={() => setShowImageSrc(false)}>
        <TouchableOpacity style={styles.modalMask} onPress={() => setShowImageSrc(false)} activeOpacity={1}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
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
        </TouchableOpacity>
      </Modal>

      {/* 消息操作 ActionSheet */}
      <Modal visible={actionIdx != null} animationType="fade" transparent onRequestClose={closeAction}>
        <TouchableOpacity style={styles.modalMask} onPress={closeAction} activeOpacity={1}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
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
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, gap: 7 },
  // 输入栏左侧附件圆形按钮（图片/文件）
  iconCircle: { width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center', marginBottom: 1 },
  // 输入栏右侧动作圆形按钮（麦克风/发送/停止）
  actionCircle: { width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center', marginBottom: 1 },
  input: { flex: 1, minHeight: 42, maxHeight: 100, borderRadius: 21, paddingHorizontal: 15, paddingTop: 10, paddingBottom: 10, fontSize: 16 },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  actionSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 8 },
  actionItem: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  bottomPanel: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, maxHeight: '70%' },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  searchInput: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 10, fontSize: 14 },
  sessionItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  modelOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  // 按住说话全屏浮层
  voiceOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  voiceCard: { width: 210, minHeight: 230, paddingVertical: 26, paddingHorizontal: 18, borderRadius: 22, backgroundColor: 'rgba(28,28,30,0.88)', borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  voiceMicCircle: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center' },
  voiceWave: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, height: 30 },
  voiceWaveBar: { width: 4, height: 24, borderRadius: 2 },
  voiceTime: { color: '#FFF', fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  voicePreviewText: { color: 'rgba(255,255,255,0.65)', fontSize: 12, lineHeight: 17, textAlign: 'center' },
  voiceHint: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '500', textAlign: 'center' },
});
