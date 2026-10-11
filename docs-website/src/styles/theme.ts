// Vibrant pixelated rainbow theme inspired by Pixel's identity
// Colors extracted from the pixelated rainbow aesthetic

export const theme = {
  colors: {
    // Background
    black: '#000000',
    darkBg: '#0a0a0a',
    cardBg: '#111111',
    
    // Rainbow colors - vibrant and saturated
    blue: '#0080ff',
    blueLight: '#00b4ff',
    blueDark: '#0056b3',
    
    purple: '#a855f7',
    purpleLight: '#c084fc',
    purpleDark: '#7c3aed',
    
    pink: '#ec4899',
    pinkLight: '#f472b6',
    pinkDark: '#db2777',
    
    orange: '#f97316',
    orangeLight: '#fb923c',
    orangeDark: '#ea580c',
    
    yellow: '#fbbf24',
    yellowLight: '#fcd34d',
    yellowDark: '#f59e0b',
    
    green: '#10b981',
    greenLight: '#34d399',
    greenDark: '#059669',
    
    // Neutrals
    gray50: '#f9fafb',
    gray100: '#f3f4f6',
    gray200: '#e5e7eb',
    gray300: '#d1d5db',
    gray400: '#9ca3af',
    gray500: '#6b7280',
    gray600: '#4b5563',
    gray700: '#374151',
    gray800: '#1f2937',
    gray900: '#111827',
    
    // Semantic colors
    success: '#10b981',
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#3b82f6',
  },
  
  gradients: {
    rainbow: 'linear-gradient(135deg, #0080ff 0%, #a855f7 25%, #ec4899 50%, #f97316 75%, #fbbf24 100%)',
    rainbowVertical: 'linear-gradient(180deg, #0080ff 0%, #a855f7 25%, #ec4899 50%, #f97316 75%, #fbbf24 100%)',
    subtle: 'linear-gradient(135deg, rgba(0,128,255,0.1) 0%, rgba(168,85,247,0.1) 100%)',
  },
  
  fonts: {
    sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
  },
  
  spacing: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
    '2xl': '3rem',
    '3xl': '4rem',
    '4xl': '6rem',
  },
  
  borderRadius: {
    sm: '0.25rem',
    md: '0.5rem',
    lg: '0.75rem',
    xl: '1rem',
    '2xl': '1.5rem',
    full: '9999px',
    pixel: '2px', // Pixelated look
  },
  
  shadows: {
    sm: '0 1px 2px 0 rgba(0, 0, 0, 0.5)',
    md: '0 4px 6px -1px rgba(0, 0, 0, 0.5), 0 2px 4px -1px rgba(0, 0, 0, 0.3)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.3)',
    xl: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.2)',
    glow: {
      blue: '0 0 20px rgba(0, 128, 255, 0.5)',
      purple: '0 0 20px rgba(168, 85, 247, 0.5)',
      pink: '0 0 20px rgba(236, 72, 153, 0.5)',
      rainbow: '0 0 30px rgba(0, 128, 255, 0.3), 0 0 60px rgba(168, 85, 247, 0.2)',
    },
  },
  
  transitions: {
    fast: '150ms ease',
    normal: '300ms ease',
    slow: '500ms ease',
  },
}

export type Theme = typeof theme
