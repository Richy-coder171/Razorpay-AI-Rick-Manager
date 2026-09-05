/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#EEF4FE',
          100: '#D9E7FD',
          200: '#B3CFFB',
          300: '#7FB0F8',
          400: '#4B96F1',
          500: '#2D89EF',
          600: '#1C6FCC',
          700: '#1657A0',
          800: '#123F75',
          900: '#0B2A52',
          950: '#071E3C',
        },
        accent: {
          DEFAULT: '#1DBF73',
          light: '#4CD796',
          dark: '#169B5B',
        },
        risk: {
          fraud: '#E5484D',
          return: '#D97706',
          abuse: '#8B5CF6',
          chargeback: '#2D89EF',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        'card-hover': '0 4px 6px -1px rgb(15 23 42 / 0.08), 0 2px 4px -2px rgb(15 23 42 / 0.05)',
        pop: '0 10px 15px -3px rgb(15 23 42 / 0.10), 0 4px 6px -4px rgb(15 23 42 / 0.08)',
        glow: '0 0 0 1px rgb(45 137 239 / 0.25), 0 4px 14px 0 rgb(45 137 239 / 0.25)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'shimmer': {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.4s ease-out both',
        'slide-up': 'slide-up 0.45s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-up-delay-1': 'slide-up 0.45s cubic-bezier(0.16, 1, 0.3, 1) 0.06s both',
        'slide-up-delay-2': 'slide-up 0.45s cubic-bezier(0.16, 1, 0.3, 1) 0.12s both',
        'slide-up-delay-3': 'slide-up 0.45s cubic-bezier(0.16, 1, 0.3, 1) 0.18s both',
      },
    },
  },
  plugins: [],
}
