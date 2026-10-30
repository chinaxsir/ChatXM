import React from 'react';
import Svg, { Rect, Path, Defs, LinearGradient, Stop } from 'react-native-svg';

export type BrandLogoProps = {
  /** 渲染边长（px） */
  size?: number;
  /** 气泡底色，默认纯白（用于蓝色/深色底） */
  bubble?: string;
  /** 字母 X 的渐变色（默认品牌蓝） */
  mark?: [string, string];
};

/**
 * Chat X 品牌标识：白色对话气泡 + 内嵌渐变 X 字标。
 * 纯矢量绘制，任意尺寸不失真；用于登录页 Logo 与对话空态，
 * 取代早期「CX」文字标识（圆形内文字易被误读为禁止符号）。
 */
export function BrandLogo({ size = 44, bubble = '#FFFFFF', mark = ['#007AFF', '#0052C2'] }: BrandLogoProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Defs>
        <LinearGradient id="cx-brand-x" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={mark[0]} />
          <Stop offset="1" stopColor={mark[1]} />
        </LinearGradient>
      </Defs>

      {/* 对话气泡：圆角主体 + 左下尖角尾巴 */}
      <Rect x="4.5" y="4.5" width="39" height="31" rx="11.5" fill={bubble} />
      <Path d="M11.5 32 L8 42.5 L24 35.2 Z" fill={bubble} />

      {/* 内嵌 X 字标 */}
      <Path
        d="M14.5 11.4 L33.5 28.6 M33.5 11.4 L14.5 28.6"
        stroke="url(#cx-brand-x)"
        strokeWidth="4.2"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

export default BrandLogo;
