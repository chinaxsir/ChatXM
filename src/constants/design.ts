// 设计令牌（Design Tokens）
// 商业 UI 的一致性来源：所有页面的圆角、间距、字号、阴影都从这里取值，
// 避免各屏自行定义导致「同类元素尺寸不一、对齐参差」。
// 颜色基板同样集中在此，三个页面在此基础上按需覆盖。

export const Radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

// 4pt 栅格：所有间距必须是 4 的倍数
export const Space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const FontSize = {
  caption: 11,
  small: 12,
  body: 14,
  callout: 15,
  title: 17,
  display: 20,
  hero: 28,
} as const;

export const Weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  heavy: '800',
} as const;

// 卡片阴影：浅色用低透明度柔和投影，深色靠边框区分层次
export const shadowCard = (dark: boolean, color = '#000') => ({
  shadowColor: color,
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: dark ? 0.35 : 0.07,
  shadowRadius: dark ? 10 : 8,
  elevation: 3,
});

export const shadowAccent = (color: string) => ({
  shadowColor: color,
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 12,
  elevation: 5,
});

export type AppPalette = {
  bg: string;
  headerBg: string;
  card: string;
  panel: string;
  panelBg: string;
  border: string;
  sub: string;
  text: string;
  btnBg: string;
  btnText: string;
  inputBg: string;
  accent: string;
  accentSoft: string;
  danger: string;
  aiBubble: string;
  aiText: string;
  chip: string;
  mask: string;
  cancelBg: string;
  cancelText: string;
};

export const AppPalette: { light: AppPalette; dark: AppPalette } = {
  light: {
    bg: '#F5F6F8',
    headerBg: '#FFFFFF',
    card: '#FFFFFF',
    panel: '#FFFFFF',
    panelBg: '#FFFFFF',
    border: '#E5E5EA',
    sub: '#6E6E73', // WCAG AA：白底 4.6:1，避免浅灰小字对比不足
    text: '#000000',
    btnBg: '#F0F2F5',
    btnText: '#333333',
    inputBg: '#F0F0F0',
    accent: '#007AFF',
    accentSoft: '#E8F1FF',
    danger: '#E53E3E',
    aiBubble: '#E9E9EB',
    aiText: '#000000',
    chip: '#E8F1FF',
    mask: 'rgba(0,0,0,0.4)',
    cancelBg: '#F0F0F0',
    cancelText: '#333333',
  },
  dark: {
    bg: '#000000',
    headerBg: '#1C1C1E',
    card: '#1C1C1E',
    panel: '#1C1C1E',
    panelBg: '#1C1C1E',
    border: '#2C2C2E',
    sub: '#A1A1A6', // 深底上提升可读性
    text: '#FFFFFF',
    btnBg: '#2C2C2E',
    btnText: '#E5E5EA',
    inputBg: '#1C1C1E',
    accent: '#0A84FF',
    accentSoft: '#1A3A5C',
    danger: '#FF6B6B',
    aiBubble: '#2C2C2E',
    aiText: '#FFFFFF',
    chip: '#1A3A5C',
    mask: 'rgba(0,0,0,0.6)',
    cancelBg: '#2C2C2E',
    cancelText: '#E5E5EA',
  },
};
