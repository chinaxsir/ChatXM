import React, { useState, useCallback } from 'react';
import { Tabs, useFocusEffect } from 'expo-router';
import { api } from '@/services/api';
import LoginScreen from './login';

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  // 每次页面聚焦时重载登录状态（支持退出登录后回到登录页）
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const c = await api.loadConfig();
        if (!active) return;
        setLoggedIn(!!c?.session_token);
        setReady(true);
      })();
      return () => { active = false; };
    }, [])
  );

  // 未就绪时空白等待，避免闪烁
  if (!ready) return null;

  // 未登录：全屏登录页，不渲染 Tab 栏
  if (!loggedIn) {
    return <LoginScreen onLoginSuccess={() => setLoggedIn(true)} />;
  }

  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: '对话' }} />
      <Tabs.Screen name="settings" options={{ title: '设置' }} />
      <Tabs.Screen name="login" options={{ href: null }} />
    </Tabs>
  );
}
