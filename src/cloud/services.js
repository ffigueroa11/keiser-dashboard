/**
 * Todo lo que toca Firebase. Se carga solo si está configurado y se usa la versión liviana de
 * Firestore: la app ya maneja por su cuenta el trabajo sin conexión.
 *
 * users/{uid}/datos/{clave}                  { valor, version }
 * users/{uid}/sesiones/{id}                  { resumen, eliminada, actualizado }
 * users/{uid}/sesiones/{id}/muestras/{n}     { datos }
 */
import { initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth'
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore/lite'
import { firebaseConfig } from './config'
import { joinSamples } from './syncCore'

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

export const onUserChanged = (callback) => onAuthStateChanged(auth, callback)
export const signInGoogle = () => signInWithPopup(auth, new GoogleAuthProvider())
export const signInEmail = (email, password) => signInWithEmailAndPassword(auth, email, password)
export const signUpEmail = (email, password) => createUserWithEmailAndPassword(auth, email, password)
export const resetPassword = (email) => sendPasswordResetEmail(auth, email)
export const logOut = () => signOut(auth)

/** Acceso a los datos de un usuario, con la forma que espera runSync. */
export function remoteFor(uid) {
  const datos = collection(db, 'users', uid, 'datos')
  const sesiones = collection(db, 'users', uid, 'sesiones')
  const muestras = (id) => collection(db, 'users', uid, 'sesiones', id, 'muestras')

  async function removeSamples(id) {
    const existing = await getDocs(muestras(id))
    await Promise.all(existing.docs.map((d) => deleteDoc(d.ref)))
  }

  return {
    async getValues() {
      const snapshot = await getDocs(datos)
      return snapshot.docs.map((d) => ({ key: d.id, ...d.data() }))
    },
    setValue: (key, valor, version) => setDoc(doc(datos, key), { valor, version }),

    async listSessions(sinceMs) {
      const snapshot = await getDocs(
        query(sesiones, where('actualizado', '>', Timestamp.fromMillis(sinceMs)), orderBy('actualizado')),
      )
      return snapshot.docs.map((d) => {
        const data = d.data()
        return { id: d.id, resumen: data.resumen, eliminada: !!data.eliminada, actualizado: data.actualizado.toMillis() }
      })
    },
    setSession: (id, resumen) => setDoc(doc(sesiones, id), { resumen, eliminada: false, actualizado: serverTimestamp() }),
    async deleteSession(id) {
      await removeSamples(id)
      // Queda una marca para que los otros equipos también la borren.
      await setDoc(doc(sesiones, id), { eliminada: true, actualizado: serverTimestamp() })
    },

    async putSamples(id, chunks) {
      await removeSamples(id)
      for (const [n, datos] of chunks.entries()) {
        await setDoc(doc(muestras(id), String(n).padStart(4, '0')), { datos })
      }
    },
    async getSamples(id) {
      const snapshot = await getDocs(query(muestras(id)))
      return joinSamples(snapshot.docs.map((d) => d.data().datos))
    },
  }
}
