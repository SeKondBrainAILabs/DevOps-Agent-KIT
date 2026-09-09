/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./renderer/**/*.{js,ts,jsx,tsx}', './index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // SeKondBrain brand colors (from sekondbrain.ai)
        sk: {
          blue: '#0033FF',        // Primary Kanvas blue
          'blue-light': '#1a8af6',
          'blue-dark': '#0022CC',
          magenta: '#e24af2',
          purple: '#8b78f5',
          orange: '#f28b68',
          gold: '#e6b800',
        },
        // Kanvas color palette (kept for legacy focus rings / active indicators)
        kanvas: {
          blue: '#0033FF',
          'blue-light': '#1a8af6',
          'blue-dark': '#0022CC',
        },
        // KIT design system accent palette (SeKondBrain DS v6)
        kit: {
          paper:  '#FAFAF7',
          blue:   '#1A8AF6',
          purple: '#8B78F5',
          pink:   '#E24AF2',
          mint:   '#3DD680',
          orange: '#F28B68',
          yellow: '#E6B800',
          lilac:  '#A88AF8',
        },
        // Light theme (SeKondBrain style - clean white)
        surface: {
          DEFAULT: '#ffffff',
          secondary: '#FAFAF7',   // was #fafafa → KIT --c-paper
          tertiary: '#f5f5f5',
        },
        // Dark theme variant
        'surface-dark': {
          DEFAULT: '#0a0a0f',
          secondary: '#12121a',
          tertiary: '#1a1a25',
        },
        accent: {
          magenta: '#e24af2',
          purple: '#8b78f5',
          blue: '#1a8af6',
          orange: '#f28b68',
          gold: '#e6b800',
        },
        border: {
          DEFAULT: 'rgba(0,0,0,0.10)',  // was #e5e7eb → KIT --c-line
          dark: '#2a2a3a',
        },
        text: {
          primary: '#000000',
          secondary: 'rgba(0,0,0,0.45)',  // KIT --c-muted
          'primary-dark': '#ffffff',
          'secondary-dark': '#a0a0a0',
        },
        // Status colors (KIT semantic)
        status: {
          idle: '#969696',
          working: '#1a8af6',
          waiting: '#F59E0B',
          error: '#EF4444',
          stopped: '#6b7280',
          success: '#10B981',
        },
      },
      fontFamily: {
        sans: ['"TT Interphases Pro"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"TT Interphases Pro Mono"', 'ui-monospace', '"JetBrains Mono"', 'monospace'],
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
      },
      borderRadius: {
        'xl': '1rem',
        '2xl': '1.5rem',
        // KIT radii
        'kit-sm':   '6px',
        'kit-md':  '10px',
        'kit-lg':  '14px',
        'kit-xl':  '22px',
        'kit-pill': '999px',
      },
      boxShadow: {
        // Legacy (kept for backward compat)
        'kanvas': '0 4px 24px rgba(0, 51, 255, 0.08)',
        'kanvas-lg': '0 8px 40px rgba(0, 51, 255, 0.12)',
        // KIT neutral shadows
        'kit-card': '0 1px 3px 0 rgba(0,0,0,0.08), 0 1px 2px -1px rgba(0,0,0,0.06)',
        'kit-pop':  '0 4px 6px -1px rgba(0,0,0,0.08), 0 2px 4px -2px rgba(0,0,0,0.06)',
        'kit-mark': '0 24px 48px rgba(139,120,245,0.18)',
        // Kept aliases
        'card': '0 1px 3px 0 rgba(0,0,0,0.08), 0 1px 2px -1px rgba(0,0,0,0.06)',
        'card-hover': '0 4px 6px -1px rgba(0,0,0,0.08), 0 2px 4px -2px rgba(0,0,0,0.06)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 2s linear infinite',
      },
    },
  },
  plugins: [],
};
