import React, { useState, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Tabs, useFocusEffect } from 'expo-router';
import { api } from '@/services/api';
import { ThemeProvider, useThemeMode } from '@/hooks/useThemeMode';
import LoginScreen from './login';

function RootLayoutInner() {
  const [ready, setReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const { scheme } = useThemeMode();

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
    return (
      <>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <LoginScreen onLoginSuccess={() => setLoggedIn(true)} />
      </>
    );
  }

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Tabs screenOptions={{ headerShown: false, tabBarStyle: { display: 'none' } }}>
        <Tabs.Screen name="index" options={{ title: '对话' }} />
        <Tabs.Screen name="settings" options={{ title: '设置' }} />
        <Tabs.Screen name="login" options={{ href: null }} />
      </Tabs>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootLayoutInner />
    </ThemeProvider>
  );
}
