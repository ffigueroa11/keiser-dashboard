import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // Web Bluetooth exige contexto seguro: localhost cumple ese requisito.
  server: { host: 'localhost', port: 5173, open: true },
  // La vista 3D (Three.js) es un bloque aparte de ~500 KB que se carga solo al usarla.
  build: { chunkSizeWarningLimit: 600 },
})
