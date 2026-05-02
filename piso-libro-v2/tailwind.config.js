/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        base:    '#050505',
        surface: '#0f0f10',
        panel:   '#151516',
        accent:  '#D4A373',
        emerald: '#34D399',
        amber:   '#F59E0B',
        red:     '#EF4444',
        blue:    '#3B82F6',
        muted:   '#6B7280',
        border:  '#1f1f22',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
