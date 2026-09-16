import { Tabs } from 'expo-router';

export default function RootLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: '对话' }} />
      <Tabs.Screen name="settings" options={{ title: '设置' }} />
      <Tabs.Screen name="login" options={{ href: null }} />
    </Tabs>
  );
}
