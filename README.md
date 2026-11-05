# Keiser M3i Lite · Telemetría y ciclismo virtual

Vue 3 (`<script setup>`) + Tailwind CSS v4 + Vite + Three.js. Lee la Keiser M3i por Web Bluetooth,
graba la sesión a 1 Hz, exporta un `.json`, guarda un historial con gráficos y ofrece rutas
virtuales en 2D y 3D (con relieve y satélite reales para rutas GPX). Opcionalmente suma el pulso
del Apple Watch o de una banda de pecho Bluetooth, con zonas de pulso.

**Usar la app sin instalar nada:** https://ffigueroa11.github.io/keiser-dashboard/

## Requisitos

- Google Chrome o Microsoft Edge de escritorio (Safari y Firefox no tienen Web Bluetooth).
- En Chrome/Edge, activar en `chrome://flags` (o `edge://flags`) y reiniciar el navegador:
  - **Experimental Web Platform features**
  - **Use the new permissions backend for Web Bluetooth**
- Adaptador Bluetooth 4.0+.
- Internet solo para el paisaje real (relieve y satélite) en la vista 3D.

## Ejecutar

### Opción A — proyecto completo (Node.js 18 o superior)

```bash
cd keiser-dashboard
npm install
npm run dev
```

Abre la dirección que muestra la terminal (normalmente http://localhost:5173).

### Opción B — solo usarla, sin Node (carpeta `dist` ya compilada)

```bash
cd keiser-dashboard/dist
python3 -m http.server 5173
```

Abre http://localhost:5173. No sirve abrir `index.html` con doble clic: Web Bluetooth necesita
`localhost` o `https://`.

## En un Mac

1. Copia la carpeta (o descomprime el .zip) donde quieras, por ejemplo en Descargas.
2. Elige la opción A (instala Node.js LTS desde nodejs.org) o la B (Python 3 viene en macOS; la
   primera vez puede pedir instalar las "herramientas de línea de comandos").
3. En *Ajustes del Sistema → Privacidad y seguridad → Bluetooth*, permite el acceso a Chrome.
   No emparejes la bicicleta en macOS: basta con pedalear para despertarla y elegir "M3" en el
   diálogo de la app.
4. Activa los flags de Chrome indicados arriba.

Lo que guarda el navegador **no se traspasa** entre equipos: historial, mejores tiempos por ruta,
rutas GPX importadas (vuelve a importar tus `.gpx`), clave de MapTiler/Esri, pulso máximo y
ajustes. Usa siempre el mismo puerto (5173) para no perder lo guardado.

## Uso

- **Conectar Bicicleta**: pedalea para despertar la consola y elige "M3". La Keiser M3i no acepta
  conexiones: la app lee sus anuncios BLE (potencia, cadencia, marcha, tiempo, calorías, distancia).
- **Conectar pulso**: ver [Pulso con Apple Watch](#pulso-con-apple-watch).
- **Simulador**: datos de prueba sin Bluetooth (incluye un pulso simulado si no hay sensor conectado).
- **Grabar sesión / Finalizar**: descarga `sesion-keiser-YYYYMMDD-HHMM.json` y guarda el resumen
  en **Historial** (con gráfico de potencia, pulso y resistencia, tiempo por zona de pulso y por
  marcha). Tiempo, calorías y distancia son los que marca la consola, aunque empieces a grabar
  tarde o reconectes; los promedios y el gráfico cubren solo lo grabado.
- **Historial → Importar sesiones**: carga uno o varios `.json` exportados, por ejemplo en otro
  equipo. Si la sesión ya estaba, se actualiza con lo que calcula el archivo.
- **Rodar → Rutas y paseo libre**: paseo libre (la marcha fija la pendiente) o rutas con perfil de elevación;
  importa GPX con **+ Importar GPX** (en **Rodar → Rutas y paseo libre**). En rutas, vista **3D** o **2D**, calidad y paisaje:
  - **Real · Sentinel-2**: gratis, resolución ~10 m.
  - **Real · MapTiler / Esri**: imagen nítida (~1 m) cerca del camino, cargada por etapas;
    requiere tu API key (en MapTiler, restringida a `localhost` y `ffigueroa11.github.io`).

## Pulso con Apple Watch

El Apple Watch no se anuncia por sí solo como sensor de pulso Bluetooth. Para eso se usa una app
gratuita que lo transmite con el perfil estándar *Heart Rate* (el mismo de las bandas de pecho),
por ejemplo **HeartCast**, **HR Broadcast**, **HeartBLE** o **Echo** (App Store).

1. Instala la app en el iPhone y el Apple Watch, ábrela e inicia el entrenamiento en el reloj.
   Según la app, el sensor aparece con el nombre del reloj o del iPhone; en las que retransmiten
   desde el iPhone, deja la app abierta en el teléfono.
2. En la app pulsa **♥ Conectar pulso** y elige el sensor en el diálogo del navegador. Puede estar
   conectado a la vez que la bicicleta.
3. El pulso aparece en **Datos en vivo** y en **Rodar** (rutas, paseo libre y videos), se graba en
   cada muestra (`pulso`, en lpm) y el resumen guarda pulso promedio y máximo. Si la conexión se
   corta, la app reintenta unas veces sola. Un salto de 25 lpm o más se ignora hasta que otra
   lectura lo confirme, también al importar una sesión.

Con el sensor conectado, Windows puede recibir los datos de la bicicleta cada varios segundos: se
midieron pausas de 12 a 25 s. La app mantiene el último valor y solo marca que no hay señal, y pone
potencia y cadencia en 0, tras 30 s sin datos. Los totales de la consola no se afectan.

También sirve cualquier banda de pecho Bluetooth (Polar, Garmin, Wahoo…). Si no hay sensor
conectado pero la consola Keiser informa pulso en sus anuncios, se usa ese.

### Zonas de pulso

Cinco zonas como porcentaje de tu pulso máximo: Z1 Recuperación (< 60 %), Z2 Resistencia
(60–70 %), Z3 Tempo (70–80 %), Z4 Umbral (80–90 %) y Z5 Máximo (≥ 90 %). Configura tu pulso máximo
en **Datos en vivo → Zonas de pulso** (por defecto 190 lpm). La zona actual se ve en vivo, en la
barra superior y mientras ruedas; el gráfico de cada sesión colorea las zonas y muestra el tiempo
en cada una. Ese tiempo se calcula con el pulso máximo configurado en ese momento, así que al
cambiarlo se recalcula también en las sesiones anteriores.

## Videos de YouTube

En **Rodar → Videos reales** hay dos formas de elegir. El video corre siempre a velocidad normal
mientras pedaleas y se pausa si paras; usa el reproductor oficial de YouTube, sin descargar nada, y
necesita internet.

- **Sorpréndeme:** elige filtros (lugar, momento, terreno, duración mínima, sin música) y la app
  escoge un video al azar que no hayas visto. Para buscar en todo YouTube necesita una clave gratuita
  de YouTube Data API v3 (console.cloud.google.com), que queda solo en tu navegador; sin clave, elige
  solo entre tu lista. **Otro video** lo descarta y sigue la rodada; **Guardar en mi lista** lo guarda
  con sus etiquetas. La duración es exacta; lugar, terreno y noche se buscan por texto y son
  aproximados, salvo en tu lista, donde las etiquetas son tuyas.
- **Mi lista:** pega el enlace de un video grabado en primera persona y pulsa **Rodar**.

- **Empezar en el segundo:** para saltarte una introducción.
- No hay pendiente real: la pone tu marcha. Tampoco hay mejores tiempos por ruta.
- Algunos autores no permiten reproducir sus videos fuera de YouTube, y pueden aparecer anuncios.

## Modo video con archivo propio

Rueda sobre un video real de la ruta, sincronizado con tu velocidad.

1. Graba el recorrido con una cámara o teléfono y, al mismo tiempo, un GPX (reloj, ciclocomputador
   o app de GPS). Conviene filmar a 60 cuadros por segundo y a una velocidad parecida a la que
   rodarás: en una subida lenta, un video filmado rápido corre a cámara lenta y se ve a saltos.
2. Importa el GPX en **Rodar → Rutas y paseo libre → + Importar GPX** y ábrelo en la vista **VIDEO**.
3. Elige el archivo de video (MP4 H.264). Se queda en tu equipo; la app solo guarda una referencia.
4. Si el video y el GPX no empezaron juntos, ajusta **Desfase del video**. Si el GPX no trae horas,
   el video se reparte parejo a lo largo de la ruta.

Si Chrome no lo reproduce (H.265/HEVC de GoPro o iPhone), conviértelo:

```bash
ffmpeg -i entrada.mp4 -c:v libx264 -crf 20 -g 30 -an salida.mp4
```

## Código

- `src/composables/useBike.js` — Bluetooth (anuncios Keiser y servicios GATT) y simulador.
- `src/composables/useHeartRate.js` — pulso por Bluetooth (Apple Watch vía app de transmisión o banda de pecho).
- `src/heartZones.js` — zonas de pulso, pulso máximo configurable y tiempo por zona.
- `src/composables/useSession.js` — grabación, exportación e historial.
- `src/routes/routes.js` — rutas incluidas, importación GPX y resultados por ruta.
- `src/components/RideScene.vue` — simulación física y vista 2D.
- `src/components/Ride3D.vue`, `src/ride/realTerrain.js`, `src/ride/pose.js` — vista 3D.
- `src/components/RideVideo.vue`, `src/routes/videoStore.js` — video con archivo propio.
- `src/components/RideYouTube.vue`, `src/routes/webVideos.js`, `src/routes/videoSearch.js` — videos de YouTube.

## Licencia

[MIT](LICENSE). Proyecto independiente, sin relación con Keiser Corporation.
