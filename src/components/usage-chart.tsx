import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontSize, Radius, Space, Weight } from '@/constants/design';

// 近 7 日用量柱状图：纯原生 View 绘制，无额外图表依赖。
// 数据来自用量统计的 daily 字典（key 为 YYYY-MM-DD）。
export function UsageChart({
  daily,
  colors,
}: {
  daily?: Record<string, { tokens?: number; count?: number }> | null;
  colors: { accent: string; sub: string; border: string; barBg: string };
}) {
  const days = useMemo(() => {
    const out: { key: string; label: string; tokens: number; count: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      // 与写入方保持一致：使用 ISO(UTC) 日期键
      const key = d.toISOString().slice(0, 10);
      const [, mm, dd] = key.split('-');
      const rec = daily?.[key];
      out.push({
        key,
        label: `${Number(mm)}/${Number(dd)}`,
        tokens: rec?.tokens || 0,
        count: rec?.count || 0,
      });
    }
    return out;
  }, [daily]);

  const max = Math.max(...days.map(d => d.tokens), 1);
  const total = days.reduce((s, d) => s + d.tokens, 0);

  const fmt = (v: number) => {
    if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  };

  return (
    <View>
      <View style={styles.head}>
        <Text style={[styles.headLabel, { color: colors.sub }]}>近 7 日消耗</Text>
        <Text style={[styles.headValue, { color: colors.accent }]}>{fmt(total)} tokens</Text>
      </View>

      <View style={styles.bars}>
        {days.map((d) => {
          const h = d.tokens > 0 ? Math.max(4, Math.round((d.tokens / max) * 56)) : 3;
          return (
            <View key={d.key} style={styles.col}>
              <Text style={[styles.value, { color: d.tokens > 0 ? colors.accent : colors.sub }]}>
                {d.tokens > 0 ? fmt(d.tokens) : ''}
              </Text>
              <View style={[styles.barTrack, { backgroundColor: colors.barBg }]}>
                <View style={[styles.bar, { height: h, backgroundColor: d.tokens > 0 ? colors.accent : colors.border }]} />
              </View>
              <Text style={[styles.date, { color: colors.sub }]}>{d.label}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: Space.md },
  headLabel: { fontSize: FontSize.small },
  headValue: { fontSize: FontSize.small, fontWeight: Weight.semibold },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: Space.sm },
  col: { flex: 1, alignItems: 'center', gap: 4 },
  value: { fontSize: 9, height: 12 },
  barTrack: { width: '100%', height: 56, borderRadius: Radius.xs, justifyContent: 'flex-end', overflow: 'hidden' },
  bar: { width: '100%', borderRadius: Radius.xs },
  date: { fontSize: 10, marginTop: 2 },
});
