# Susurro · chat por sonido

**Susurro** es un chat web que transmite mensajes **por el aire mediante sonido audible**. Escribes
un texto, la página lo convierte en tonos y lo reproduce por el altavoz; otro dispositivo con la misma
página abierta y el micrófono activo lo escucha y lo muestra como mensaje entrante. También puede
transcribir archivos de audio.

- 100 % estático: HTML, CSS y JavaScript vanilla.
- Sin frameworks, sin backend, sin cuentas y **sin dependencias de npm** para ejecutar la app.
- Todo el procesamiento ocurre en el navegador con Web Audio API.
- Módem 16-FSK con Hamming(8,4), CRC-16/CCITT, entrelazado y repeticiones.
- Perfiles **Rápido**, **Normal** y **Alcance (10 m)**.

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
> micrófono. Para probar desde un móvil, publica la app en Vercel (HTTPS) o usa un túnel HTTPS.

---

## Cómo usarla con dos teléfonos

1. Abre la misma URL de Susurro en los dos teléfonos.
2. En el **teléfono B**, pulsa **Escuchar** y acepta el permiso de micrófono. Verás `Escuchando…`
   y el medidor de nivel.
3. En el **teléfono A**, escribe un mensaje y pulsa enviar. El texto se reproduce al instante como
   tonos y aparece una burbuja saliente con `reproduciendo…` → `emitido`.
4. En el **teléfono B**, la burbuja entrante aparece con la etiqueta `recibido · <perfil>`.
5. Para responder, pulsa **Escuchar** en el teléfono A y envía desde B. El micrófono de un teléfono
   puede estar apagado mientras el otro emite; no hace falta tenerlo siempre activo.
6. El botón de altavoz de una burbuja saliente **vuelve a emitir** el mensaje sin crear otra burbuja.
7. El clip del compositor permite cargar un WAV, MP3, M4A, OGG o WebM y transcribirlo, sin micrófono.
   La burbuja resultante se etiqueta como `audio transcrito`.

Consejos de uso:

- Mantén el teléfono que escucha a la vista y con el micrófono despejado.
- Baja el volumen del teléfono que escucha si capta su propio altavoz; Susurro ya ignora el eco de sus
  propias emisiones durante la duración del audio más 3 segundos.
- Si un mensaje no llega, aumenta las repeticiones o cambia al perfil **Alcance (10 m)**.

### Cómo conseguir los ~10 metros

1. Abre **Ajustes** en el teléfono emisor y elige **Alcance (10 m)**. El perfil fija 3 repeticiones
   automáticamente (puedes subirlas a 4 o 5 si el entorno es difícil).
2. Sube el **Volumen** a 90–100 y pon el altavoz del teléfono emisor hacia el otro teléfono, sin
   taparlo con la mano.
3. Coloca los teléfonos a la misma altura y evita paredes, cristales o superficies duras justo en
   medio: el eco y la reverberación reducen el alcance.
4. Usa una sala silenciosa, sin música ni conversaciones de fondo ni ventiladores fuertes.
5. Deja el teléfono receptor quieto y con el micrófono orientado hacia el emisor. El perfil Alcance
   usa una banda estrecha (0,49–1,55 kHz), pensada para resistir eco, ruido y volumen bajo.
6. Los mensajes cortos funcionan mejor. Si necesitas más margen, envía frases breves y sube las
   repeticiones antes que el volumen por encima del 100 % (no existe).

La robustez del módem está probada con el perfil Alcance a −12 dB de SNR con 2 repeticiones, y con
3 repeticiones aguanta eco, ruido y una señal al 1,2 % de amplitud.

---

## Ajustes

Panel desplegable desde el engranaje de la cabecera.

| Ajuste | Valores | Inicial |
| --- | --- | --- |
| Perfil | Rápido / Normal / Alcance (10 m) | Normal |
| Repeticiones | 1–5 | 2 |
| Volumen | 10–100 | 85 |

- **Rápido**: símbolos de 10,7 ms, banda 0,84–5,06 kHz, 187 bits/s útiles. Para distancias cortas.
- **Normal**: símbolos de 21,3 ms, banda 0,89–3,00 kHz, 94 bits/s útiles. Uso general.
- **Alcance (10 m)**: símbolos de 42,7 ms, banda 0,49–1,55 kHz, 47 bits/s útiles. Más lento pero
  resistente al eco, al ruido y al volumen bajo.
- La nota inferior muestra la descripción del perfil y el tiempo estimado de emisión del mensaje
  actual.
- Al elegir **Alcance** se ponen 3 repeticiones.
- Los ajustes se guardan en `localStorage`.

El texto se normaliza y se limita a **200 bytes UTF-8**. Si se recorta, aparece un aviso.

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
de ruido y sin ganancia automática; si el dispositivo no usa 48 kHz, se remuestrea.

API pública de `js/phy.js`:

```js
PHY.renderAudio(texto, { preset, reps, amplitude }) // → { samples, duration, preset, reps }
PHY.decodeBuffer(samples, { sampleRate, preset })   // → [{ text, preset, start, end }]
PHY.LiveDecoder({ onPacket, onSync, onStatus })     // append / tick / trim / reset
PHY.encodeWav(samples, sampleRate)                  // → Uint8Array WAV PCM 16 bits mono
PHY.resample(samples, desde, hacia)
PHY.SR, PHY.MAX_PAYLOAD, PHY.PRESETS, PHY.PRESET_ORDER, PHY.getPreset(id)
```

---

## Pruebas

Requisitos: **Node.js 18 o superior** y **Google Chrome** (o Edge/Chromium). No hay que instalar
nada más. Las pruebas de navegador lanzan Chrome headless mediante el protocolo DevTools, sin
Puppeteer ni Playwright.

```powershell
node tests/phy.test.js   # módem: 23 pruebas
node tests/ui.test.js    # interfaz en Chrome headless: 10 pruebas
node tests/mic.test.js   # micrófono falso de Chrome: 6 comprobaciones
```

Si Chrome no está en una ruta habitual, indica el ejecutable:

```powershell
$env:CHROME_PATH = "C:\ruta\a\chrome.exe"
node tests/ui.test.js
```

Qué cubre cada suite:

- **`tests/phy.test.js`**: Hamming(8,4) y corrección de errores, paquete y CRC, perfiles limpios,
  autodetección, repeticiones, ruido progresivo hasta −12 dB, eco, señal al 1,2 %, captura a 44,1 kHz,
  payload máximo, ausencia de falsos positivos, decodificador en streaming y CPU por tick.
- **`tests/ui.test.js`**: título y marca, ausencia de «Cómo funciona», diseño sin desbordamiento en
  390×844, 768×1024 y 1280×900, ajustes por defecto, Alcance → 3 repeticiones, envío de «HOLA CHAT»
  con `reproduciendo…` → `emitido`, reemisión sin duplicar burbuja, transcripción de un WAV generado
  al vuelo con etiqueta `audio transcrito`, agrupación `×N` de mensajes repetidos, supresión de eco y
  encendido/apagado del micrófono.
- **`tests/mic.test.js`**: genera un WAV con `PHY.renderAudio`, lo inyecta con
  `--use-file-for-fake-audio-capture` y comprueba que la app lo recibe por el micrófono, mueve el
  medidor de nivel, agrupa las repeticiones y no genera errores de consola.

Las pruebas crean perfiles temporales de Chrome y los eliminan al terminar. `tests/` está excluido de
Git y de Vercel.

---

## Estructura del proyecto

```
index.html         Interfaz de chat
styles.css         Estilos (móvil primero, modo oscuro, movimiento reducido)
js/phy.js          Módem: paquetes, Hamming, CRC, síntesis, FFT, decodificador
js/app.js          Chat, emisión, micrófono, archivos, estados
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
- **Permiso denegado**: actívalo en el candado de la barra de direcciones y recarga.
- **No llega el mensaje**: acerca los teléfonos, sube el volumen, elige **Alcance** y aumenta las
  repeticiones. Evita música, ruido y superficies muy reverberantes.
- **El archivo no se transcribe**: debe contener una grabación de Susurro. Los formatos no soportados
  por el navegador muestran un aviso.
- **Chrome no se encuentra en las pruebas**: define `CHROME_PATH` con la ruta del ejecutable.

---

Hecho con Web Audio API, sin dependencias. **Susurro · chat por sonido.**
