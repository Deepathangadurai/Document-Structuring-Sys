/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // AmperePro Design System palette (see DESIGN_SYSTEM.md)
        brand: {
          DEFAULT: '#1A3A6B', // DARK_BLUE — primary
          dark: '#12294d',
          light: '#e3f2fd',
        },
        accent: {
          DEFAULT: '#F97316', // ORANGE — secondary/action
          dark: '#ea6a0c',
          light: '#fff3e0',
        },
        success: { DEFAULT: '#2e7d32', light: '#e8f5e9' },
        danger: { DEFAULT: '#c62828', light: '#ffebee' },
        info: { DEFAULT: '#1565c0', light: '#e3f2fd' },
        review: { DEFAULT: '#6a1b9a', light: '#f3e5f5' },
        warning: { DEFAULT: '#f57f17', light: '#fff8e1' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['Georgia', 'ui-serif', 'serif'],
      },
      keyframes: {
        slideIn: {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
      animation: {
        slideIn: 'slideIn 0.25s ease-out',
      },
    },
  },
  plugins: [],
}