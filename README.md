# SoundBridge · mensajes que suenan

**SoundBridge** es un chat web que transmite mensajes **por el aire mediante sonido audible**.
Escribes un texto y lo envías: aparece tu mensaje y, justo después, como un mensaje aparte, el
**audio** que empieza a sonar por el altavoz. Otro teléfono que tenga la página abierta y esté en
rango **lo escucha con el micrófono y escribe el mensaje solo en su chat**, sin enviar ni abrir
ningún archivo.

- 100 % estático: HTML, CSS y JavaScript vanilla.
- Sin frameworks, sin backend, sin cuentas y **sin dependencias de npm** para ejecutar la app.
- Todo el procesamiento ocurre en el navegador con Web Audio API.
- Módem 16-FSK con Hamming(8,4), CRC-16/CCITT, entrelazado y repeticiones.
- Compartir o descargar el audio, y transcribir un archivo de audio, son **opcionales**.

---

## Inicio rápido

### Windows

Haz doble clic en **`abrir.bat`**. Arranca el servidor local y abre
<http://localhost:8080> en el navegador.

### Cualquier sistema con Node.js

```powershell
node servidor.js
```

Después abre <http://localhost:8080>. Para usar otro puerto:

```powershell
node servidor.js 8081
```

### Alternativa con Python

```powershell
python -m http.server 8080
```

> **Importante:** el micrófono solo funciona en contextos seguros. Usa
> `http://localhost`, `http://127.0.0.1` o una URL `https://`. Si abres `index.html` con doble clic
> (`file://`) o entras desde otro equipo por `http://192.168.x.x`, el navegador bloqueará el
> micrófono. Para probar con teléfonos, publica la app en Vercel (HTTPS) o usa un túnel HTTPS.

---

## Cómo usarla con dos teléfonos

1. Abre la misma URL de SoundBridge en los dos teléfonos.
2. **Acepta el permiso de micrófono** cuando el navegador lo pida. La app empieza a escuchar sola
   al abrirse; verás el estado `Micrófono activo · escuchando` y el medidor de nivel.
3. En el teléfono A escribe un mensaje y pulsa enviar. Aparecen dos mensajes seguidos: primero el
   **texto** y después el **audio**, que suena de inmediato (`reproduciendo…` → `audio listo`).
4. En el teléfono B, si está en rango, el mensaje aparece solo como burbuja entrante con la etiqueta
   `audio recibido · Normal`.
5. Para responder, escribe en B. No hace falta activar nada en A: ya está escuchando.

Detalles del comportamiento:

- **Permiso de micrófono:** es obligatorio la primera vez y ninguna web puede saltárselo. En Chrome,
  Edge y Android se recuerda para el sitio (en HTTPS). En Safari de iPhone puede volver a pedirse
  cada vez; se evita en Ajustes → Safari → Micrófono, o con «aA» → Ajustes del sitio web → Micrófono
  → Permitir.
- **Si el navegador bloquea el arranque automático**, la app lo reintenta con el primer toque en la
  pantalla. Al enviar el primer mensaje también se enciende el micrófono si estaba apagado.
- **Silenciar:** el icono del micrófono en la cabecera lo apaga. Si lo apagas tú, no se vuelve a
  encender solo hasta que lo pulses de nuevo.
- **Sin eco propio:** mientras un teléfono reproduce su audio, su micrófono no se escucha a sí mismo,
  y se ignora el eco del mismo texto durante la duración del audio más 3 segundos.
- **Repeticiones:** si llega el mismo mensaje varias veces en 15 segundos, se agrupa en una sola
  burbuja con un contador `×N`.
- **Texto máximo:** el mensaje se normaliza y se limita a **200 bytes UTF-8**. Si se recorta, aparece
  un aviso.

### Opcional: compartir, descargar y transcribir archivos

Nada de esto es necesario para que el chat funcione.

- En la burbuja de audio, el botón de tres puntos (**⋮**) muestra **Compartir audio** y
  **Descargar audio** (WAV). Compartir usa el menú del sistema si el dispositivo lo permite; si no,
  descarga el archivo.
- El botón **Copiar texto** copia el contenido de cualquier burbuja.
- El **clip** del compositor (o arrastrar un audio sobre la conversación) abre un WAV, MP3, M4A, OGG
  o WebM y lo transcribe sin micrófono. La burbuja resultante se etiqueta `audio transcrito`.
- Las burbujas entrantes incluyen un reproductor con el audio regenerado a partir del texto, por si
  quieres escucharlo o reenviarlo.

### Consejos para mejorar el alcance

1. Sube el volumen del teléfono emisor y orienta su altavoz hacia el receptor, sin taparlo.
2. Coloca los teléfonos a la misma altura y evita paredes, cristales o superficies duras en medio:
   el eco y la reverberación reducen el alcance.
3. Usa un lugar silencioso, sin música, conversaciones ni ventiladores fuertes.
4. Mantén el receptor quieto y con el micrófono despejado.
5. Los mensajes cortos funcionan mejor.

---

## Parámetros de emisión

La interfaz no tiene panel de ajustes: la emisión usa valores fijos definidos al inicio de
`js/app.js`.

| Parámetro | Valor |
| --- | --- |
| Perfil | Normal |
| Repeticiones del paquete | 2 |
| Volumen (amplitud) | 0,9 |

El receptor **detecta el perfil automáticamente**, así que no hace falta configurar nada en ese
lado. Para cambiar los valores de emisión, edita `EMIT_PRESET`, `EMIT_REPS` y `EMIT_VOLUME` en
`js/app.js`. El módem admite tres perfiles:

| Perfil | Símbolo | Banda | Velocidad útil | Uso |
| --- | --- | --- | --- | --- |
| Rápido | 10,7 ms | 0,84–5,06 kHz | 187 bits/s | Distancias cortas |
| Normal | 21,3 ms | 0,89–3,00 kHz | 94 bits/s | Uso general |
| Alcance (10 m) | 42,7 ms | 0,49–1,55 kHz | 47 bits/s | Más lento, resistente a eco y ruido |

---

## Protocolo acústico

| Bloque | Técnica |
| --- | --- |
| Modulación | 16-FSK: cada símbolo usa uno de 16 tonos → 4 bits |
| Frecuencia de muestreo | 48 kHz |
| Tonos | Alineados a bins exactos de la FFT |
| Sincronía | Preámbulo de 16 símbolos, correlación deslizante y ajuste fino a 1 muestra |
| Errores | Hamming (8,4) extendido + entrelazado de bloques de 4 palabras |
| Integridad | CRC-16/CCITT; si un paquete falla, se descarta |
| Paquete | `[0xA5][versión][longitud][UTF-8…][CRC-16]` |
| Robustez | Repetición del paquete completo (1–5 veces) con pausa entre copias |
| Payload máximo | 200 bytes |

La emisión añade 25 ms de silencio inicial, una pausa de 280 ms entre copias y 80 ms de cola. El
decodificador detecta el perfil automáticamente, agrupa las repeticiones de un mismo paquete y
descarta ruido puro. En recepción por micrófono se captura mono sin cancelación de eco, sin supresión
de ruido y sin ganancia automática (con AudioWorklet y, si no existe, `ScriptProcessor`); si el
dispositivo no usa 48 kHz, se remuestrea.

API pública de `js/phy.js`:

```js
PHY.renderAudio(texto, { preset, reps, amplitude }) // → { samples, duration, preset, reps }
PHY.decodeBuffer(samples, { sampleRate, preset })   // → [{ text, preset, start, end }]
PHY.LiveDecoder({ onPacket, onSync, onStatus })     // append / tick / trim / reset
PHY.encodeWav(samples, sampleRate)                  // → Uint8Array WAV PCM 16 bits mono
PHY.resample(samples, desde, hacia)
PHY.SR, PHY.MAX_PAYLOAD, PHY.PRESETS, PHY.PRESET_ORDER, PHY.getPreset(id)
```

`js/app.js` expone además `window.SoundBridge` (`messages`, `send`, `incoming`, `transcribe`, `play`,
`stop`) como API mínima para pruebas automatizadas.

---

## Pruebas

Requisitos: **Node.js 18 o superior**. Las pruebas de navegador necesitan además **Google Chrome**
(o Edge/Chromium) y lanzan Chrome headless mediante el protocolo DevTools, sin Puppeteer ni
Playwright.

```powershell
node tests/phy.test.js   # módem: 23 pruebas
node tests/ui.test.js    # interfaz en Chrome headless
node tests/mic.test.js   # micrófono falso de Chrome
node tests/experimentos.js todo   # experimentos del artículo (unos 10 min; escribe resultados.json)
```

> **Estado actual:** `tests/phy.test.js` es válida para esta versión. `tests/ui.test.js` y
> `tests/mic.test.js` fueron escritas para una versión anterior (usan `window.Susurro`, el botón
> `btnListen`, un panel de ajustes y `localStorage`) y **hay que actualizarlas** antes de volver a
> usarlas.

Si Chrome no está en una ruta habitual, indica el ejecutable:

```powershell
$env:CHROME_PATH = "C:\ruta\a\chrome.exe"
node tests/ui.test.js
```

Qué cubre cada suite:

- **`tests/phy.test.js`**: Hamming(8,4) y corrección de errores, paquete y CRC, perfiles limpios,
  autodetección, repeticiones, ruido progresivo hasta −12 dB, eco, señal al 1,2 %, captura a 44,1 kHz,
  payload máximo, ausencia de falsos positivos, decodificador en streaming y CPU por tick.
- **`tests/ui.test.js`**: interfaz, envío, reproducción, transcripción de archivos, agrupación `×N`,
  supresión de eco y micrófono (pendiente de adaptar, ver arriba).
- **`tests/mic.test.js`**: inyecta un WAV como micrófono falso de Chrome y comprueba la recepción en
  vivo (pendiente de adaptar, ver arriba).

Las pruebas crean perfiles temporales de Chrome y los eliminan al terminar. `tests/` está excluido de
Git y de Vercel.

---

## Estructura del proyecto

```
index.html         Interfaz de chat
styles.css         Estilos (móvil primero, modo oscuro, movimiento reducido)
js/phy.js          Módem: paquetes, Hamming, CRC, síntesis, FFT, decodificador
js/app.js          Chat, emisión, micrófono automático, archivos, estados
servidor.js        Servidor local sin dependencias (puerto 8080)
abrir.bat          Inicio rápido en Windows
vercel.json        Cabeceras y configuración de Vercel
.vercelignore      Exclusiones de Vercel
.gitignore         Exclusiones de GitHub
README.md          Este documento
tests/phy.test.js  Pruebas del módem
tests/ui.test.js   Pruebas de la interfaz
tests/mic.test.js  Recepción por micrófono simulado
tests/cdp.js       Cliente mínimo de Chrome DevTools Protocol usado por las pruebas
tests/experimentos.js  Experimentos del artículo (ruido, reverberación, ráfagas, modelo teórico…)
```

---

## Publicar en Vercel

La app es estática: no hay build ni dependencias. El directorio de salida es `./`.

### Con la CLI

Desde la carpeta del proyecto, en PowerShell de Windows:

```powershell
npx.cmd vercel login
npx.cmd vercel --prod
```

En CMD, macOS o Linux usa `npx` en lugar de `npx.cmd`. La primera vez acepta los valores propuestos:
framework **Other**, sin comando de build y salida `./`. Vercel servirá la app por HTTPS, así que el
micrófono funcionará también desde móviles.

### Desde GitHub

1. Sube el proyecto a un repositorio de GitHub.
2. En Vercel, elige **Add New → Project** e importa el repositorio.
3. Framework Preset: **Other**. Build Command: vacío. Output Directory: `./`.
4. Pulsa **Deploy**. Cada push a la rama principal volverá a publicar la app.

### Cabeceras incluidas

`vercel.json` configura:

- `Permissions-Policy: microphone=(self)` para permitir el micrófono en el propio sitio.
- `X-Content-Type-Options: nosniff`.
- `Cache-Control: public, max-age=0, must-revalidate` para `/js/*`, de modo que los cambios se vean
  al instante.

### Archivos locales que no deben publicarse

`.vercelignore` y `.gitignore` excluyen `tests/`, `servidor.js`, `abrir.bat`, `vercel.json`,
`.vercelignore`, `node_modules/`, `.vercel/`, variables de entorno, ficheros del sistema y `*.log`.

Si esos archivos ya estaban subidos a GitHub, deja de rastrearlos una vez:

```powershell
git rm -r --cached tests servidor.js abrir.bat vercel.json .vercelignore
git commit -m "Quitar archivos locales del repositorio"
```

No borra los archivos de tu disco; solo deja de seguirlos Git.

> **Nota sobre `vercel.json`:** la CLI de Vercel lee este archivo localmente aunque esté en
> `.vercelignore`, por lo que las cabeceras siguen aplicándose con `vercel --prod`. Si publicas
> importando el repositorio desde GitHub, al no estar el archivo en el repositorio esas cabeceras no
> se aplican; configúralas en **Project → Settings → Headers** o vuelve a incluir `vercel.json` en
> Git quitándolo de `.gitignore`.

---

## Solución de problemas

- **«El micrófono requiere HTTPS o localhost»**: abre la app por `http://localhost`, `127.0.0.1` o
  HTTPS. `file://` y las IP locales por HTTP no son contextos seguros.
- **Permiso denegado**: actívalo en el candado de la barra de direcciones y recarga. En iPhone,
  revisa Ajustes → Safari → Micrófono.
- **El micrófono no se enciende solo**: toca cualquier parte de la pantalla (algunos navegadores lo
  exigen) o pulsa el icono del micrófono.
- **No llega el mensaje**: comprueba que el otro teléfono muestre `Micrófono activo · escuchando`,
  acércalos, sube el volumen del emisor y evita música, ruido y superficies muy reverberantes.
- **El archivo no se transcribe**: debe contener una grabación de SoundBridge. Los formatos no
  soportados por el navegador muestran un aviso.
- **Chrome no se encuentra en las pruebas**: define `CHROME_PATH` con la ruta del ejecutable.

---

Hecho con Web Audio API, sin dependencias. **SoundBridge · mensajes que suenan.**
