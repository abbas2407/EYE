module.exports = {
  content: ['./App.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#faf9f6',
        surface: '#ffffff',
        'surface-low': '#f4f3f1',
        'surface-container': '#efeeeb',
        'on-surface': '#1a1c1a',
        'on-surface-variant': '#444748',
        primary: '#000000',
        secondary: '#695d4a',
        'secondary-container': '#f2e0c8',
        outline: '#747878',
        'outline-variant': '#c4c7c7',
      },
      fontFamily: {
        sans: ['DM-Sans', 'System'],
        playfair: ['PlayfairDisplay-Bold', 'System'],
      },
    },
  },
  plugins: [],
};
