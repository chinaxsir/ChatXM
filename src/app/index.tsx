import React, { useState, useCallback, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView, Platform, SafeAreaView, Modal, Alert, Image, Pressable, Animated, ScrollView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useThemeMode } from '@/hooks/useThemeMode';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { ThemedText } from '@/components/themed-text';
import { ModelIcon } from '@/components/model-icon';
import { api } from '@/services/api';
import * as Clipboard from 'expo-clipboard';
import Markdown from 'react-native-markdown-display';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import LoginScreen from './login';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';

const BUILTIN_ENDPOINT = 'https://gate.127110.xyz';

// 单张图片 base64 字符数上限（约 450KB 图片二进制）。
// 商业场景下必须保守：请求体过大时 iOS 端 fetch 会直接抛
// "Bad file descriptor"（ExpoModulesCore/Promise.swift）导致发送失败。
// 该上限只在内部生效，对用户完全静默——用户永远不需要知道图片被压缩过。
const IMAGE_B64_BUDGET = 600 * 1024;

// 自动压缩档位：从高画质逐级降到 256px，正常照片必定能在第一/二档落入预算
const COMPRESS_STEPS = [
  { width: 1024, compress: 0.6 },
  { width: 768, compress: 0.5 },
  { width: 640, compress: 0.45 },
  { width: 512, compress: 0.4 },
  { width: 384, compress: 0.35 },
  { width: 320, compress: 0.3 },
  { width: 256, compress: 0.25 },
];

// 从 URI 读取 base64：支持 data: 与本地 file://（ph://、blob: 无法直接读取）
async function readBase64FromUri(uri: string): Promise<string> {
  if (!uri) return '';
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    return comma >= 0 ? uri.slice(comma + 1) : '';
  }
  if (!uri.startsWith('file://')) return '';
  try {
    return await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  } catch {
    return '';
  }
}

// 对单个来源做逐级压缩，返回首个落入预算的结果；全部超限时返回最小结果（不报错）
async function compressSource(source: string): Promise<string> {
  let smallest = '';
  for (const step of COMPRESS_STEPS) {
    try {
      const rendered = await ImageManipulator.manipulate(source).resize({ width: step.width }).renderAsync();
      const saved = await rendered.saveAsync({ compress: step.compress, format: SaveFormat.JPEG, base64: true });
      let b64 = saved?.base64 || '';
      // 新版 API 差异兜底：saveAsync 未返回 base64 时回读落盘文件
      if (!b64) b64 = await readBase64FromUri(saved?.uri || '');
      if (!b64) continue;
      const dataUrl = `data:image/jpeg;base64,${b64}`;
      if (b64.length <= IMAGE_B64_BUDGET) return dataUrl;
      smallest = dataUrl;
    } catch {
      // 该档位失败则继续降级，不中断整体流程
    }
  }
  return smallest;
}

// 压缩图片为 data URL：全程静默自动处理，不抛错、不打断用户操作。
// 依次尝试「原始 uri」→「选择器返回的 base64」→「直接读取文件」，
// 任意一路成功即返回；全部失败返回空串，由调用方静默降级。
async function compressImageToDataUrl(uri: string, fallbackBase64?: string, mime?: string): Promise<string> {
  const primary = await compressSource(uri);
  if (primary) return primary;

  // 路径 A：用选择器已给的 base64 重建 data URL 再压缩（原 uri 不可操作时最有效）
  if (fallbackBase64) {
    const rebuilt = await compressSource(`data:${mime || 'image/jpeg'};base64,${fallbackBase64}`);
    if (rebuilt) return rebuilt;
  }

  // 路径 B：直接读取本地文件（仅 file:// 可读）
  const raw = await readBase64FromUri(uri);
  if (raw && raw.length <= IMAGE_B64_BUDGET) {
    const safeMime = uri.startsWith('data:') ? uri.slice(5, uri.indexOf(';')) : 'image/jpeg';
    return `data:${safeMime};base64,${raw}`;
  }
  return '';
}

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
  // 用量统计独立于账号存储：登录/启动时把本地累计统计水合回 config 供设置页展示
  const hydrateUsage = async (c: any) => {
    if (!c) return c;
    const stats = await api.loadUsageStats();
    if (stats) {
      const merged = { ...c, usage: stats };
      await api.saveConfig(merged);
      return merged;
    }
    return c;
  };
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
  const [showDrawPanel, setShowDrawPanel] = useState(false);
  const [drawPrompt, setDrawPrompt] = useState('');
  const [drawSize, setDrawSize] = useState('1024x1024');
  const [drawN, setDrawN] = useState(1);
  const [drawing, setDrawing] = useState(false);
  const [drawResult, setDrawResult] = useState<{ urls: string[]; error?: string } | null>(null);
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
      Alert.alert('Chat X', '语音识别失败: ' + (event.message || event.error));
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
        const c0 = await api.loadConfig();
        const c = await hydrateUsage(c0);
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
      if (perm.status !== 'granted') { Alert.alert('Chat X', '需要授权访问' + (useCamera ? '相机' : '相册')); return; }

      const result = useCamera
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled || !result.assets?.[0]) return;
      const asset: any = result.assets[0];

      // 全程静默自动压缩：用户无感知，绝不因体积提示打断操作
      const dataUrl = await compressImageToDataUrl(asset.uri, asset.base64, asset.mimeType);
      if (!dataUrl) {
        // 极端情况下（图片损坏/格式不支持）才提示，且不提体积
        Alert.alert('Chat X', '这张图片无法读取，请换一张试试');
        return;
      }
      setImage(dataUrl);
    } catch (e: any) {
      Alert.alert('Chat X', '获取图片失败: ' + (e?.message || e));
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
        // 图片统一走图片通道：静默自动压缩，不提示体积
        let dataUrl = '';
        try {
          dataUrl = await compressImageToDataUrl(file.uri);
        } catch {
          dataUrl = '';
        }
        if (!dataUrl) {
          Alert.alert('Chat X', '这张图片无法读取，请换一张试试');
          return;
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
            'Chat X',
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
      Alert.alert('Chat X', '选择文件失败: ' + (e?.message || e));
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
      Alert.alert('Chat X', '余额不足，请前往「设置」充值后继续使用');
      return;
    }

    const target = resolveTarget();
    if (!target.token) {
      Alert.alert('Chat X', '未配置 API Key，请重新登录或在设置中添加 API');
      return;
    }

    // 组装最终提示文本（含文件内容）
    let promptText = textToSend;
    if (fileName && fileContent) {
      const fileBlock = `\n\n--- 附件文件: ${fileName} ---\n${fileContent}\n--- 附件文件结束 ---\n`;
      promptText = promptText ? `${promptText}${fileBlock}` : fileBlock.trim();
    }

    const displayText = textToSend.trim();

    // 对话内「帮我生成一张图」类请求：直接走图片生成通道，
    // 否则对话模型只会回答「我无法生成图片」，体验不成立
    if (!image && !fileName && detectDrawIntent(displayText)) {
      await inlineDraw(displayText);
      return;
    }

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
          // 历史里含 base64 图片，Web 端 localStorage 有配额上限。
          // 写失败时自动剥离图片重试，全程静默，不影响本次对话结果
          try {
            await api.saveHistory(sessionId, finalMessages);
          } catch {
            try {
              await api.saveHistory(sessionId, finalMessages.map((m: any) => ({ ...m, image: null })));
            } catch { /* 仍失败则放弃本地记录，不打断用户 */ }
          }

          // 累计消耗统计 + 本地估算扣费（统计独立持久化，退出/切换账号不归零）
          const day = new Date().toISOString().slice(0, 10);
          const curCfg = configRef.current || config;
          const u = (await api.loadUsageStats()) || { total: 0, prompt: 0, completion: 0, count: 0, daily: {} as any };
          const d = u.daily[day] || { tokens: 0, count: 0 };
          // 估算扣费金额（按综合 $2 / 1M tokens 估算，仅本地即时反馈，最终以服务端为准）
          const estimatedCost = total * 0.000002;
          const newBalance = curCfg.balance != null ? Math.max(0, Number(curCfg.balance) - estimatedCost) : curCfg.balance;
          const newUsage = {
            total: (u.total || 0) + total,
            prompt: (u.prompt || 0) + (usage?.prompt_tokens || 0),
            completion: (u.completion || 0) + (usage?.completion_tokens || 0),
            count: (u.count || 0) + 1,
            daily: { ...u.daily, [day]: { tokens: d.tokens + total, count: d.count + 1 } },
          };
          await api.saveUsageStats(newUsage);
          const newConfig = {
            ...curCfg,
            balance: newBalance,
            usage: newUsage,
          };
          await api.saveConfig(newConfig);
          applyConfig(newConfig);

          // 同步服务端真实余额
          if (curCfg.session_token) {
            try {
              const r = await api.refreshAccount(curCfg.session_token);
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
        const rawMsg = String(e?.message || e);
        // 传输层异常：网络中断 / 网关拒绝。不再向用户暴露体积相关提示
        if (rawMsg.includes('Bad file descriptor') || rawMsg.includes('fetch failed') || rawMsg.includes('Network request failed')) {
          Alert.alert('Chat X', '网络连接中断，请检查网络后重试');
        } else if (/(并发量较大|并发|繁忙|排队|拥挤|秒后重试|rate limit|overload|too many requests)/i.test(rawMsg)) {
          // 自动重试仍失败：给用户商业化的柔性提示，不透出门户内部限流文案
          Alert.alert('Chat X', '当前使用人数较多，请稍后再试');
        } else {
          Alert.alert('Chat X', '对话请求失败: ' + rawMsg);
        }
        console.error(e);
      }
    } finally {
      setSending(false);
    }
  };

  const stopStreaming = () => { if (abortRef.current) abortRef.current.abort(); };

  // ===== 图片生成（/v1/images/generations）=====
  const drawImage = async () => {
    if (!drawPrompt.trim() || drawing) return;
    setDrawing(true);
    setDrawResult(null);
    const target = resolveTarget();
    try {
      const { urls, error } = await api.generateImage({
        endpoint: target.endpoint,
        token: target.token,
        prompt: drawPrompt.trim(),
        n: drawN,
        size: drawSize,
      });
      if (error) {
        setDrawResult({ urls: [], error });
        Alert.alert('图片生成失败', error);
      } else if (urls.length === 0) {
        setDrawResult({ urls: [], error: '未返回图片' });
      } else {
        setDrawResult({ urls });
        // 把生成的图片和 prompt 作为消息追加到对话
        const userMsg: Msg = { role: 'user', content: `🎨 生成图片：${drawPrompt.trim()}`, displayContent: `🎨 生成图片：${drawPrompt.trim()}` };
        const aiContent = urls.map(u => `![生成图](${u})`).join('\n');
        const aiMsg: Msg = { role: 'assistant', content: aiContent };
        const newMessages = [...messages, userMsg, aiMsg];
        setMessages(newMessages);
        await api.saveHistory(sessionId, newMessages);
        setShowDrawPanel(false);
        setDrawPrompt('');
      }
    } catch (e: any) {
      Alert.alert('图片生成失败', e?.message || '未知错误');
      setDrawResult({ urls: [], error: e?.message });
    } finally {
      setDrawing(false);
    }
  };

  // 识别「让 AI 直接出图」的对话意图：对话模型本身不能出图，
  // 命中意图时自动转交图片生成通道，用户无需再点画笔按钮。
  const detectDrawIntent = (t: string): boolean => {
    const s = t.trim();
    if (!s || s.length > 120) return false;
    // 排除识图/分析类请求
    if (/(识别|描述|分析|看图|这是什么|图里|图中|翻译)/.test(s)) return false;
    const hasAction = /(生成|画一|画个|画张|绘制|设计|做一|做张|来一张|给我一张|出图|帮我画|帮我生成)/.test(s);
    const hasObject = /(图片|照片|插画|海报|头像|壁纸|logo|图标|绘画|漫画|动图|表情包|图)/.test(s);
    return hasAction && hasObject;
  };

  // 对话内直接出图：把结果作为 AI 回复插入会话
  const inlineDraw = async (prompt: string) => {
    const target = resolveTarget();
    const userMsg: Msg = { role: 'user', content: prompt, displayContent: prompt };
    const aiMsg: Msg = { role: 'assistant', content: '' };
    const newMessages = [...messages, userMsg, aiMsg];
    aiMsgKeyRef.current = '';
    aiTextRef.current = '';
    setMessages(newMessages);
    setInput('');
    setSending(true);
    try {
      const { urls, error } = await api.generateImage({
        endpoint: target.endpoint,
        token: target.token,
        prompt,
        n: 1,
        size: '1024x1024',
      });
      const reply = urls.length > 0
        ? urls.map((u, i) => `![生成图${i + 1}](${u})`).join('\n')
        : `图片生成失败，请稍后重试。${error ? `（${error}）` : ''}`;
      aiTextRef.current = reply;
      const finalMessages = [...newMessages];
      finalMessages[finalMessages.length - 1] = { role: 'assistant', content: reply };
      setMessages(finalMessages);
      try { await api.saveHistory(sessionId, finalMessages); } catch {}
    } catch (e: any) {
      const reply = `图片生成失败，请稍后重试。`;
      const finalMessages = [...newMessages];
      finalMessages[finalMessages.length - 1] = { role: 'assistant', content: reply };
      setMessages(finalMessages);
    } finally {
      setSending(false);
    }
  };

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
    if (messages.length === 0) { Alert.alert('Chat X', '当前会话无内容可导出'); return; }
    const text = messages.map(m => {
      const role = m.role === 'user' ? '我' : 'AI';
      return `[${role}]\n${m.displayContent || m.content}`;
    }).join('\n\n');
    const full = `Chat X 会话导出\n时间: ${new Date().toLocaleString()}\n模型: ${model === 'frapi' ? '官方 API' : model}\n\n${text}`;
    await Clipboard.setStringAsync(full);
    Alert.alert('Chat X', '会话内容已复制到剪贴板，可粘贴到任意位置保存');
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
        Alert.alert('Chat X', '需要麦克风与语音识别权限，请在系统设置中开启');
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
      Alert.alert('Chat X', '启动语音识别失败: ' + (e?.message || e));
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
  // 官方模型：gate.127110.xyz 的 /v1/models 免鉴权，无条件拉取
  //   池名识别：gemini、glm 等（存在其他 id = 池名 + '-' + 版本号）
  //   当前模型若不在列表中 → 自动回退第一池
  // 第三方API：服务端 /v1/models 为权威来源，拉取失败静默降级保留本地快照
  const refreshThirdPartyModels = async (baseConfig: any) => {
    const apis: any[] = [...(baseConfig?.third_party_apis || [])];
    let changed = false;

    // ===== 官方模型同步：无条件拉取（/v1/models 免鉴权） =====
    let fetchedIds: string[] | null = null;
    try {
      const endpoint = baseConfig?.builtin_endpoint || BUILTIN_ENDPOINT;
      const res = await api.fetchModels(endpoint);
      const ids: string[] = Array.from(new Set(res?.data?.map((m: any) => m.id).filter(Boolean) || []));
      if (ids.length > 0) {
        fetchedIds = ids;
        // 池名识别：该 id + '-' + 数字开头的其他 id 存在
        const poolNames = ids.filter((id) => ids.some((o) => o !== id && new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d`).test(o)));
        const prevIds: string[] = baseConfig?.official_model_ids || [];
        if (JSON.stringify(ids) !== JSON.stringify(prevIds)) changed = true;
        const prevGroups: string[] = baseConfig?.official_groups?.length ? baseConfig.official_groups : [];
        if (JSON.stringify(poolNames) !== JSON.stringify(prevGroups)) changed = true;
      }
    } catch { /* 静默降级 */ }

    // ===== 第三方 API 同步 =====
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
      } catch { /* 静默降级：网络异常时保留本地快照 */ }
    }));

    // 没变化且无新数据则跳过写回
    if (!changed && !fetchedIds) return;

    const latest = configRef.current || baseConfig;
    const updated: any = { ...latest, third_party_apis: apis };
    if (fetchedIds) updated.official_model_ids = fetchedIds;

    // ===== 自动回退：当前选中的模型不在新列表中 =====
    const curIds: string[] = updated.official_model_ids?.length ? updated.official_model_ids : [];
    // 从完整 ids 实时识别池名
    const curPoolNames = curIds.filter((id) => curIds.some((o) => o !== id && new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d`).test(o)));
    // 兜底：如果没有池名但有 ids，用第一个 id 作为 fallback
    const groupsNow: string[] = curPoolNames.length > 0 ? curPoolNames : (curIds.length > 0 ? curIds : (updated.official_groups?.length ? updated.official_groups : []));

    const cur = String(updated.current_model || '');
    if (cur.startsWith('tp:')) {
      const parts = cur.split(':');
      const idx = Number(parts[1]);
      const modelName = parts.slice(2).join(':');
      if (!apis[idx]?.models?.includes(modelName)) {
        const fallback = groupsNow[0];
        if (fallback) { updated.current_model = fallback; setModel(fallback); }
      }
    } else if (fetchedIds && !groupsNow.includes(cur) && !curIds.includes(cur)) {
      // 官方模型被删除/改名 → 回退第一池
      const fallback = groupsNow[0];
      if (fallback) { updated.current_model = fallback; setModel(fallback); }
    }
    applyConfig(updated);
    await api.saveConfig(updated);
  };

  const handleLoginSuccess = async () => {
    const c0 = await api.loadConfig();
    const c = await hydrateUsage(c0);
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

  // 官方智能模型组（池）：渲染端从 /v1/models 完整列表实时过滤，不依赖缓存
  // 规则：存在其他 id = 该 id + '-' + 数字（版本号）开头 → 池名（gemini、glm…）
  const _allIds: string[] = config?.official_model_ids?.length ? config.official_model_ids : [];
  const _escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const officialModels: string[] = _allIds.length > 0
    ? _allIds.filter((id) => _allIds.some((o) => o !== id && new RegExp(`^${_escapeRegExp(id)}-\\d`).test(o)))
    : (config?.official_groups?.length ? config.official_groups : ['frapi']);
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
            <ThemedText style={[styles.emptyTitle, { color: C.btnText }]}>你好，我是 Chat X</ThemedText>
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

        {/* 输入区：图片生成 | 图片 | 附件 | 输入框 | 麦克风/发送/停止 */}
        <View style={[styles.inputBar, { backgroundColor: C.headerBg, borderTopColor: C.border }]}>
          <Pressable
            style={({ pressed }) => [styles.iconCircle, { backgroundColor: C.btnBg }, pressed && { opacity: 0.5 }]}
            onPress={() => { setShowDrawPanel(true); setDrawResult(null); }}
            hitSlop={8}
          >
            <Ionicons name="brush-outline" size={22} color={C.btnText} />
          </Pressable>
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
        <View style={styles.modalMask}>
          <Pressable style={{ flex: 1 }} onPress={() => { setShowHistory(false); setSearchKw(''); }} />
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

      {/* 模型选择面板 — 卡片化网格布局 */}
      <Modal visible={showModel} animationType="slide" transparent onRequestClose={() => setShowModel(false)}>
        <View style={styles.modalMask}>
          <Pressable style={{ flex: 1 }} onPress={() => setShowModel(false)} />
          <View style={[styles.bottomPanel, { backgroundColor: C.panelBg }]}>
            <View style={styles.panelHeader}>
              <ThemedText type="subtitle">选择模型</ThemedText>
              <TouchableOpacity onPress={() => setShowModel(false)}><ThemedText style={{ color: C.sub }}>关闭</ThemedText></TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 480 }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
              {/* 官方模型卡片组 */}
              <View style={styles.modelSectionHeader}>
                <View style={[styles.modelSectionDot, { backgroundColor: C.accent }]} />
                <ThemedText style={[styles.modelSectionTitle, { color: C.sub }]}>官方智能模型</ThemedText>
                <ThemedText style={[styles.modelSectionCount, { color: C.sub }]}>{officialModels.length} 组</ThemedText>
              </View>
              <View style={styles.modelCardGrid}>
                {officialModels.map((m) => {
                  const isSelected = model === m;
                  // 估算该池包含的模型数量
                  const groupIds = _allIds.filter((id) => id === m || id.startsWith(`${m}-`));
                  return (
                    <TouchableOpacity
                      key={`of-${m}`}
                      style={[
                        styles.modelCard,
                        {
                          backgroundColor: C.bg,
                          borderColor: isSelected ? C.accent : C.border,
                          borderWidth: isSelected ? 2 : 1,
                          shadowOpacity: isSelected ? 0.15 : 0,
                          shadowColor: C.accent,
                          shadowOffset: { width: 0, height: 2 },
                          shadowRadius: 8,
                          elevation: isSelected ? 3 : 0,
                        },
                      ]}
                      onPress={() => changeModel(m)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.modelCardTop}>
                        <ModelIcon name={m} size={26} color={C.aiText} />
                        {isSelected && (
                          <View style={[styles.modelCardCheck, { backgroundColor: C.accent }]}>
                            <Text style={styles.modelCardCheckText}>✓</Text>
                          </View>
                        )}
                      </View>
                      <ThemedText style={[styles.modelCardName, isSelected && { color: C.accent }]}>{m}</ThemedText>
                      <View style={[styles.modelCardBadge, { backgroundColor: C.accentSoft }]}>
                        <ThemedText style={[styles.modelCardBadgeText, { color: C.accent }]}>{groupIds.length || 1} 个模型</ThemedText>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* 第三方 API 卡片组 */}
              {thirdPartyModels.length > 0 && (
                <>
                  <View style={styles.modelSectionHeader}>
                    <View style={[styles.modelSectionDot, { backgroundColor: '#34C759' }]} />
                    <ThemedText style={[styles.modelSectionTitle, { color: C.sub }]}>第三方 API</ThemedText>
                    <ThemedText style={[styles.modelSectionCount, { color: C.sub }]}>{thirdPartyModels.length} 个</ThemedText>
                  </View>
                  <View style={styles.modelCardGrid}>
                    {thirdPartyModels.map((m) => {
                      const isSelected = model === m.value;
                      return (
                        <TouchableOpacity
                          key={m.value}
                          style={[
                            styles.modelCard,
                            {
                              backgroundColor: C.bg,
                              borderColor: isSelected ? C.accent : C.border,
                              borderWidth: isSelected ? 2 : 1,
                              shadowOpacity: isSelected ? 0.15 : 0,
                              shadowColor: C.accent,
                              shadowOffset: { width: 0, height: 2 },
                              shadowRadius: 8,
                              elevation: isSelected ? 3 : 0,
                            },
                          ]}
                          onPress={() => changeModel(m.value)}
                          activeOpacity={0.7}
                        >
                          <View style={styles.modelCardTop}>
                            <View style={[styles.modelCardDot, { backgroundColor: isSelected ? C.accent : '#34C759' }]} />
                            {isSelected && (
                              <View style={[styles.modelCardCheck, { backgroundColor: C.accent }]}>
                                <Text style={styles.modelCardCheckText}>✓</Text>
                              </View>
                            )}
                          </View>
                          <ThemedText style={[styles.modelCardName, isSelected && { color: C.accent }]} numberOfLines={1}>{m.label.split(' · ')[0]}</ThemedText>
                          <ThemedText style={[styles.modelCardSub, { color: C.sub }]} numberOfLines={1}>{m.label.split(' · ')[1] || m.value}</ThemedText>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              )}

              {/* 当前选中提示 */}
              <View style={[styles.modelFooterHint, { backgroundColor: C.bg }]}>
                <Text style={[styles.modelFooterIcon, { color: C.accent }]}>💡</Text>
                <ThemedText style={[styles.modelFooterText, { color: C.sub }]}>
                  {model === 'frapi' || isOfficialModel(model)
                    ? '当前使用：官方 API · 流量稳定 · 免 Key'
                    : '当前使用：第三方 API · 消耗独立额度'}
                </ThemedText>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 图片来源选择 ActionSheet：拍照 / 相册 */}
      <Modal visible={showImageSrc} animationType="fade" transparent onRequestClose={() => setShowImageSrc(false)}>
        <View style={styles.modalMask}>
          <Pressable style={{ flex: 1 }} onPress={() => setShowImageSrc(false)} />
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
        </View>
      </Modal>

      {/* 图片生成面板 */}
      <Modal visible={showDrawPanel} animationType="slide" transparent onRequestClose={() => setShowDrawPanel(false)}>
        <View style={styles.modalMask}>
          <Pressable style={{ flex: 1 }} onPress={() => !drawing && setShowDrawPanel(false)} />
          <View style={[styles.drawPanel, { backgroundColor: C.panelBg }]}>
            {/* 内部拦截层，防止面板内点击冒泡 */}
            <Pressable style={{ flex: 1 }} onPress={() => {}}>
              <View style={[styles.drawPanelHandle, { backgroundColor: C.border }]} />
              <View style={styles.drawHeader}>
                <Ionicons name="brush" size={22} color={C.accent} />
                <ThemedText type="subtitle" style={{ flex: 1, marginLeft: 8 }}>图片生成</ThemedText>
                <TouchableOpacity onPress={() => !drawing && setShowDrawPanel(false)}>
                  <Ionicons name="close" size={22} color={C.sub} />
                </TouchableOpacity>
              </View>

              <View style={[styles.drawBody]}>
                <ThemedText style={[styles.drawLabel, { color: C.sub }]}>描述你想要的图片</ThemedText>
                <TextInput
                  style={[styles.drawInput, { backgroundColor: C.inputBg, color: C.aiText, borderColor: C.border }]}
                  value={drawPrompt}
                  onChangeText={setDrawPrompt}
                  placeholder="例如：一只戴墨镜的橘猫坐在沙发上"
                  placeholderTextColor={C.sub}
                  multiline
                  editable={!drawing}
                />

                <View style={styles.drawRow}>
                  <ThemedText style={[styles.drawLabel, { color: C.sub }]}>尺寸</ThemedText>
                  <View style={styles.drawChips}>
                    {['1024x1024', '1024x1536', '1536x1024'].map(s => (
                      <TouchableOpacity key={s}
                        style={[styles.drawChip, { backgroundColor: drawSize === s ? C.accent : C.inputBg, borderColor: drawSize === s ? C.accent : C.border }]}
                        onPress={() => setDrawSize(s)}
                        disabled={drawing}
                      >
                        <Text style={{ color: drawSize === s ? '#FFF' : C.btnText, fontSize: 13 }}>{s}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                <View style={styles.drawRow}>
                  <ThemedText style={[styles.drawLabel, { color: C.sub }]}>数量</ThemedText>
                  <View style={styles.drawChips}>
                    {[1, 2, 4].map(n => (
                      <TouchableOpacity key={n}
                        style={[styles.drawChip, { backgroundColor: drawN === n ? C.accent : C.inputBg, borderColor: drawN === n ? C.accent : C.border }]}
                        onPress={() => setDrawN(n)}
                        disabled={drawing}
                      >
                        <Text style={{ color: drawN === n ? '#FFF' : C.btnText, fontSize: 13 }}>{n}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* 生成结果预览 */}
                {drawResult?.urls && drawResult.urls.length > 0 && (
                  <View style={styles.drawResultGrid}>
                    {drawResult.urls.map((u, i) => (
                      <View key={i} style={[styles.drawResultCard, { backgroundColor: C.inputBg }]}>
                        <Image source={{ uri: u }} style={styles.drawResultImg} />
                      </View>
                    ))}
                  </View>
                )}
                {drawResult?.error && (
                  <Text style={{ color: C.danger, textAlign: 'center', marginTop: 8 }}>{drawResult.error}</Text>
                )}
              </View>

              <View style={[styles.drawFooter, { borderTopColor: C.border }]}>
                <TouchableOpacity
                  style={[styles.drawBtn, { backgroundColor: C.inputBg, borderColor: C.border }]}
                  onPress={() => !drawing && setShowDrawPanel(false)}
                  disabled={drawing}
                >
                  <Text style={{ color: C.btnText }}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.drawBtn, { backgroundColor: drawPrompt.trim() && !drawing ? C.accent : C.inputBg }]}
                  onPress={drawImage}
                  disabled={!drawPrompt.trim() || drawing}
                >
                  {drawing ? (
                    <Text style={{ color: C.btnText }}>生成中...</Text>
                  ) : (
                    <Text style={{ color: '#FFF' }}>🎨 生成图片</Text>
                  )}
                </TouchableOpacity>
              </View>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* 消息操作 ActionSheet */}
      <Modal visible={actionIdx != null} animationType="fade" transparent onRequestClose={closeAction}>
        <View style={styles.modalMask}>
          <Pressable style={{ flex: 1 }} onPress={closeAction} />
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
        </View>
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
  // 图片生成面板
  drawPanel: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 8, maxHeight: '80%' },
  drawPanelHandle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
  drawHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  drawBody: { paddingHorizontal: 16, paddingVertical: 12 },
  drawLabel: { fontSize: 13, marginBottom: 6 },
  drawInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 80, fontSize: 15, marginBottom: 16 },
  drawRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  drawChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  drawChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  drawResultGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  drawResultCard: { borderRadius: 12, overflow: 'hidden', aspectRatio: 1, width: '48%' },
  drawResultImg: { width: '100%', height: '100%' },
  drawFooter: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  drawBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },

  actionSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 8 },
  actionItem: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  bottomPanel: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, paddingBottom: 28, maxHeight: '70%' },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  searchInput: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 10, fontSize: 14 },
  sessionItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  modelOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  // ===== 模型选择器卡片化样式 =====
  modelSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 10, paddingHorizontal: 2 },
  modelSectionDot: { width: 6, height: 6, borderRadius: 3 },
  modelSectionTitle: { fontSize: 13, fontWeight: '600', flex: 1 },
  modelSectionCount: { fontSize: 11 },
  modelCardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 },
  modelCard: {
    width: '48%',
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    paddingBottom: 10,
  },
  modelCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  modelCardDot: { width: 10, height: 10, borderRadius: 5 },
  modelCardCheck: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  modelCardCheckText: { color: '#FFF', fontSize: 11, fontWeight: '700', lineHeight: 13 },
  modelCardName: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  modelCardSub: { fontSize: 11, marginTop: 2 },
  modelCardBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 4 },
  modelCardBadgeText: { fontSize: 10, fontWeight: '600' },
  modelFooterHint: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  modelFooterIcon: { fontSize: 16 },
  modelFooterText: { fontSize: 12, flex: 1, lineHeight: 16 },
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
