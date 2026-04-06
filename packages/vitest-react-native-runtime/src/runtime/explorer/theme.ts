import { createTheme } from '@shopify/restyle';

const theme = createTheme({
  colors: {
    bg: '#0f172a',
    surface: '#1e293b',
    surfaceActive: '#334155',
    border: '#334155',
    text: '#e2e8f0',
    textMuted: '#94a3b8',
    textDim: '#64748b',
    accent: '#60a5fa',
    pass: '#4ade80',
    fail: '#f87171',
    warning: '#fbbf24',
    white: '#ffffff',
    black: '#000000',
    transparent: 'transparent',
    checkboxOff: '#475569',
    checkboxOn: '#60a5fa',
  },
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
  textVariants: {
    defaults: { color: 'text', fontSize: 14 },
    heading: { color: 'text', fontSize: 18, fontWeight: '700' as const },
    subheading: { color: 'text', fontSize: 16, fontWeight: '600' as const },
    body: { color: 'text', fontSize: 14 },
    caption: { color: 'textMuted', fontSize: 12 },
    mono: { color: 'textMuted', fontSize: 12, fontFamily: 'monospace' as const },
    button: { color: 'white', fontSize: 14, fontWeight: '600' as const },
    badge: { fontSize: 14, fontWeight: '700' as const },
  },
});

export type Theme = typeof theme;
export default theme;
