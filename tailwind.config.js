/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./src/**/*.{ts,tsx,html,js}",
    "./public/**/*.{html,js,json}",
    "./themes/**/*.{html,js,json}",
    "./scripts/*.mjs",
    "!./public/shared/app.css",
    "!./public/styles/**"
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
