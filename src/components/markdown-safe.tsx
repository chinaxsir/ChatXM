import React from 'react';
import { Text } from 'react-native';
import Markdown from 'react-native-markdown-display';

// Markdown 渲染兜底：AI 回复内容由远端生成，可能包含解析器不支持的构造
// （超长 base64 图片、异常符号、非字符串 content 等）。
// 一旦 Markdown 组件抛错，退化为纯文本渲染，绝不整屏报错。
class Boundary extends React.Component<
  { children: React.ReactNode; fallback: string; textStyle: any },
  { failed: boolean }
> {
  state = { failed: false };

  componentDidCatch(error: any, info: any) {
    // 记录到控制台便于排查，但不影响界面
    console.warn('[ChatX] markdown fallback:', error?.message || error, info?.componentStack);
    this.setState({ failed: true });
  }

  render() {
    if (this.state.failed) {
      return <Text style={this.props.textStyle}>{this.props.fallback}</Text>;
    }
    return this.props.children as any;
  }
}

export function MarkdownSafe({ content, style, textStyle }: {
  content: any;
  style: any;
  textStyle: any;
}) {
  // content 必须是字符串：旧数据或异常链路可能写入数组/对象
  const text = typeof content === 'string' ? content : String(content ?? '');
  if (!text) return null;
  return (
    <Boundary fallback={text} textStyle={textStyle}>
      <Markdown style={style}>{text}</Markdown>
    </Boundary>
  );
}
