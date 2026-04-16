import { createTheme } from '@shopify/restyle';

export type ThemeMode = 'light' | 'dark';

const shared = {
  spacing: {
    none: 0,
    xs: 4,
    s: 8,
    m: 12,
    l: 16,
    xl: 24,
    xxl: 32,
  },
  borderRadii: {
    none: 0,
    s: 4,
    m: 8,
    l: 12,
    full: 999,
  },
};

const textVariants = {
  defaults: { color: 'text' as const, fontSize: 14 },
  heading: { color: 'text' as const, fontSize: 18, fontWeight: '700' as const },
  subheading: { color: 'text' as const, fontSize: 16, fontWeight: '600' as const },
  body: { color: 'text' as const, fontSize: 14 },
  caption: { color: 'textMuted' as const, fontSize: 12 },
  mono: { color: 'textMuted' as const, fontSize: 12, fontFamily: 'monospace' as const },
  button: { color: 'white' as const, fontSize: 14, fontWeight: '600' as const },
  badge: { fontSize: 14, fontWeight: '700' as const },
};

export const darkTheme = createTheme({
  ...shared,
  colors: {
    bg: '#121212',
    surface: '#1e1e1e',
    surfaceActive: '#2c2c2c',
    border: '#2c2c2c',
    text: '#e0e0e0',
    textMuted: '#9e9e9e',
    textDim: '#757575',
    testContainerBg: '#2a2a2a',
    accent: '#60a5fa',
    pass: '#4ade80',
    fail: '#f87171',
    warning: '#fbbf24',
    white: '#ffffff',
    black: '#000000',
    transparent: 'transparent',
    checkboxOff: '#424242',
    checkboxOn: '#60a5fa',
  },
  textVariants,
});

export const lightTheme: Theme = {
  ...darkTheme,
  colors: {
    bg: '#f5f5f5',
    surface: '#ffffff',
    surfaceActive: '#e8e8e8',
    border: '#d4d4d4',
    text: '#171717',
    textMuted: '#525252',
    textDim: '#a3a3a3',
    testContainerBg: '#ffffff',
    accent: '#3b82f6',
    pass: '#16a34a',
    fail: '#dc2626',
    warning: '#d97706',
    white: '#ffffff',
    black: '#000000',
    transparent: 'transparent',
    checkboxOff: '#d4d4d4',
    checkboxOn: '#3b82f6',
  },
};

export function getTheme(mode: ThemeMode): Theme {
  return mode === 'light' ? lightTheme : darkTheme;
}

export type Theme = typeof darkTheme;
export default darkTheme;
