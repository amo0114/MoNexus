/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#6366F1',
          hover: '#4F46E5',
        },
        secondary: '#818CF8',
        cta: {
          DEFAULT: '#22C55E',
          hover: '#16A34A',
        },
      },
      fontFamily: {
        heading: ['Orbitron', 'sans-serif'],
        body: ['"Exo 2"', 'sans-serif'],
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0, 0, 0, 0.05)',
        md: '0 4px 6px rgba(0, 0, 0, 0.1)',
        lg: '0 10px 15px rgba(0, 0, 0, 0.1)',
        xl: '0 20px 25px rgba(0, 0, 0, 0.15)',
        focus: '0 0 0 3px rgba(99, 102, 241, 0.2)',
      },
    },
  },
  plugins: [],
}
