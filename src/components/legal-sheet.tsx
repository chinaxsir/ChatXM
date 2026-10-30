import React from 'react';
import { Modal, View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { LEGAL_DOCS, LegalKind } from '@/constants/brand';

// 协议/隐私条款弹层：底部抽屉式，深浅色自适应。
// 登录页与设置页共用，避免两处文案分叉。
export function LegalSheet({
  kind,
  visible,
  onClose,
  colors,
  confirmText,
  onConfirm,
}: {
  kind: LegalKind | null;
  visible: boolean;
  onClose: () => void;
  colors: { bg: string; panel: string; border: string; sub: string; text: string; accent: string; mask: string };
  confirmText?: string;
  onConfirm?: () => void;
}) {
  const doc = kind ? LEGAL_DOCS[kind] : null;
  const C = colors;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={[styles.mask, { backgroundColor: C.mask }]}>
        <SafeAreaView style={[styles.sheet, { backgroundColor: C.panel }]}>
          <View style={[styles.header, { borderBottomColor: C.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: C.text }]}>{doc?.title || ''}</Text>
              <Text style={[styles.updated, { color: C.sub }]}>更新日期：{doc?.updated || ''}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={[styles.close, { color: C.sub }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            {(doc?.body || []).map((para, i) => (
              <Text key={i} style={[styles.para, { color: C.text }]}>{para}</Text>
            ))}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: C.border }]}>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: C.accent }]}
              onPress={onConfirm || onClose}
              activeOpacity={0.85}
            >
              <Text style={styles.btnText}>{confirmText || '我已知悉'}</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '86%', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '700' },
  updated: { fontSize: 11, marginTop: 3 },
  close: { fontSize: 18, fontWeight: '600' },
  body: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24, gap: 14 },
  para: { fontSize: 13.5, lineHeight: 22 },
  footer: { paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  btn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  btnText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
});
