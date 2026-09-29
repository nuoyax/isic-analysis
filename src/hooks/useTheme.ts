import { useEffect, useState } from 'react';
import type { ThemeMode } from '../theme/tokens';

const KEY = 'isic-theme';

/** 已选定的主题：显式选择优先，否则跟随系统。 */
export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem(KEY, mode);
  }, [mode]);

  return [mode, setMode];
}
