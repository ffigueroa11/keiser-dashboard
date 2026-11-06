import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

createApp(App).mount('#app')

// Permite abrir la app ya visitada sin conexión. Bluetooth no necesita internet.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* la app funciona igual, solo que necesita conexión al abrirla */
  })
}
