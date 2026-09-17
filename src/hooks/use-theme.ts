/**
 * 主题：支持 auto / light / dark 手动切换
 */
import { Colors } from '@/constants/theme';
import { useThemeMode } from './useThemeMode';

export function useTheme() {
  const { scheme } = useThemeMode();
  return Colors[scheme];
}
