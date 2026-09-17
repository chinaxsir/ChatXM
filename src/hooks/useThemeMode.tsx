import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeMode = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'theme_mode';

type ThemeContextValue = {
  mode: ThemeMode;
  scheme: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('auto');

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'auto') {
        setModeState(saved);
      }
    })();
  }, []);

  const setMode = useCallback(async (m: ThemeMode) => {
    setModeState(m);
    await AsyncStorage.setItem(STORAGE_KEY, m);
  }, []);

  const scheme: 'light' | 'dark' = mode === 'auto' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;

  return (
    <ThemeContext.Provider value={{ mode, scheme, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeMode(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemeMode must be used within ThemeProvider');
  return ctx;
}
