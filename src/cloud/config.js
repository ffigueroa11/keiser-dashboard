/**
 * Configuración web de Firebase. Estos valores identifican el proyecto y no son secretos: lo que
 * protege los datos son las reglas de firestore.rules. Sin ellos, la app funciona solo en el navegador.
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const isCloudConfigured = Object.values(firebaseConfig).every(Boolean)
