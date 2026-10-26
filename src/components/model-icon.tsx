import React from 'react';
import Svg, { Path, Rect, Circle, G, Line, Defs, LinearGradient, Stop } from 'react-native-svg';

export type ModelIconProps = {
  /** 模型池/模型名，用于识别品牌 */
  name: string;
  size?: number;
  /** 单色图标的主色（跟随主题） */
  color?: string;
};

// Gemini 四角星（Sparkle）轮廓
const SPARK =
  'M12 1.2C12.72 7.15 16.85 11.28 22.8 12C16.85 12.72 12.72 16.85 12 22.8C11.28 16.85 7.15 12.72 1.2 12C7.15 11.28 11.28 7.15 12 1.2Z';

// OpenAI 官方结形标记
const OPENAI_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

// Claude 放射光标记
const CLAUDE_RAYS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i * Math.PI) / 4 - Math.PI / 2;
  const inner = i % 2 === 0 ? 3.4 : 4.6;
  const outer = i % 2 === 0 ? 10.6 : 9.2;
  return {
    x1: 12 + inner * Math.cos(angle),
    y1: 12 + inner * Math.sin(angle),
    x2: 12 + outer * Math.cos(angle),
    y2: 12 + outer * Math.sin(angle),
  };
});

/**
 * 模型品牌图标：按模型池/模型名渲染真实品牌标识（Gemini / GLM / OpenAI / Claude / Kilo），
 * 未识别时回退为当前主题色的通用星标。
 */
export function ModelIcon({ name, size = 26, color = '#111114' }: ModelIconProps) {
  const key = (name || '').toLowerCase();

  // Gemini：四角星 + 蓝紫粉渐变
  if (key.includes('gemini') || key.includes('bard')) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Defs>
          <LinearGradient id="cx-gemini" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#4285F4" />
            <Stop offset="0.55" stopColor="#9B72CB" />
            <Stop offset="1" stopColor="#D96570" />
          </LinearGradient>
        </Defs>
        <Path d={SPARK} fill="url(#cx-gemini)" />
      </Svg>
    );
  }

  // GLM / 智谱：圆角方标 + 渐变底 + 白色 Z 字
  if (key.includes('glm') || key.includes('zhipu') || key.includes('bigmodel')) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Defs>
          <LinearGradient id="cx-glm" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#3D6BFF" />
            <Stop offset="1" stopColor="#7E4DFF" />
          </LinearGradient>
        </Defs>
        <Rect x="1.2" y="1.2" width="21.6" height="21.6" rx="6.4" fill="url(#cx-glm)" />
        <Path d="M6.6 6.9H17.4V9.3L10.7 14.7H17.4V17.1H6.6V14.7L13.3 9.3H6.6Z" fill="#FFFFFF" />
      </Svg>
    );
  }

  // OpenAI / GPT：官方结形标记（跟随主题色）
  if (key.includes('gpt') || key.includes('openai') || key.includes('o1') || key.includes('o3')) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={OPENAI_PATH} fill={color} />
      </Svg>
    );
  }

  // Claude / Anthropic：橙陶色放射光
  if (key.includes('claude') || key.includes('anthropic')) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <G stroke="#D97757" strokeWidth="2.6" strokeLinecap="round">
          {CLAUDE_RAYS.map((r, i) => (
            <Line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
          ))}
        </G>
      </Svg>
    );
  }

  // Kilo：闪电
  if (key.includes('kilo')) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M13.6 1.8 4.2 13.4h5.4l-1.4 8.8 9.6-11.8h-5.6z" fill="#FFB020" />
      </Svg>
    );
  }

  // DeepSeek：鲸形/双弧，这里用蓝绿圆底 + 白色星简化标识
  if (key.includes('deepseek')) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle cx="12" cy="12" r="10.4" fill="#4D6BFE" />
        <Path d={SPARK} fill="#FFFFFF" transform="translate(4.6 4.6) scale(0.615)" />
      </Svg>
    );
  }

  // 通用回退：主题色星标
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={SPARK} fill={color} opacity={0.85} />
    </Svg>
  );
}

export default ModelIcon;
