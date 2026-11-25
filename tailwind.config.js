/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./src/**/*.{ts,tsx,html,js}",
    "./public/**/*.{html,js}",
    "./themes/**/*.{html,js,json}",
    "./scripts/gen-seed-univers.mjs",
    "!./public/shared/app.css",
    "!./public/styles/**"
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
