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
          50: '#fff7ed',
          100: '#ffedd5',
          400: '#fb923c',
          500: '#f97316', // Cloudflare orange accent
          600: '#ea580c',
          700: '#c2410c',
        },
        dark: {
          900: '#090a0f',
          800: '#12141d',
          700: '#1a1d2b',
          600: '#25293d',
        }
      },
      fontFamily: {
        sans: ['Inter', 'Outfit', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
