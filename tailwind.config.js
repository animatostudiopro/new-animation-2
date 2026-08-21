/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  safelist: [
    { pattern: /animate-/ },
    { pattern: /opacity-/ },
    { pattern: /scale-/ },
    { pattern: /bg-/ },
    { pattern: /border-/ },
    { pattern: /rounded-/ },
    'text-white', 'font-bold', 'cursor-pointer', 'select-none',
    'rounded-full', 'items-center', 'justify-center', 'flex',
    'absolute', 'pointer-events-none'
  ],
  theme: {
    extend: {
      keyframes: {
        vibrate: {
          '0%': { transform: 'translate(0)' },
          '25%': { transform: 'translate(-2px, 2px)' },
          '50%': { transform: 'translate(2px, -2px)' },
          '75%': { transform: 'translate(-2px, -2px)' },
          '100%': { transform: 'translate(2px, 2px)' },
        },
        floatUp: {
          '0%': { opacity: '1', transform: 'translate(-50%, 0) scale(1)' },
          '100%': { opacity: '0', transform: 'translate(-50%, -35px) scale(1.15)' },
        }
      },
      animation: {
        'vibrate': 'vibrate 0.1s linear infinite',
        'float-up': 'floatUp 1.5s ease-out forwards',
      }
    },
  },
  plugins: [],
};
