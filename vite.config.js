import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Versión visible en la app: el commit con el que se compiló.
function appVersion() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'local'
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  // Rutas relativas: la misma compilación sirve en GitHub Pages (en una subcarpeta) y en localhost.
  base: './',
  // Web Bluetooth exige contexto seguro: localhost cumple ese requisito.
  server: { host: 'localhost', port: 5173, open: true },
  // La vista 3D (Three.js) es un bloque aparte de ~500 KB que se carga solo al usarla.
  build: { chunkSizeWarningLimit: 600 },
  test: { include: ['tests/**/*.test.js'], environment: 'node' },
})
