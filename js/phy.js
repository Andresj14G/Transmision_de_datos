/*
 * Susurro · capa física (PHY)
 * Módem acústico 16-FSK, 48 kHz, tonos alineados a bins de la FFT,
 * Hamming(8,4) extendido, entrelazado de bloques de 4 palabras y CRC-16/CCITT.
 *
 * API pública:
 *   PHY.renderAudio(texto, { preset, reps, amplitude }) -> { samples, duration }
 *   PHY.decodeBuffer(samples, { sampleRate, preset })   -> [{ text, preset }]
 *   PHY.LiveDecoder({ onPacket, onSync, onStatus })     -> append / tick / trim
 *   PHY.encodeWav(samples, sampleRate)                  -> Uint8Array
 *   PHY.resample(samples, desde, hacia)                 -> Float32Array
 *   PHY.SR, PHY.MAX_PAYLOAD, PHY.PRESETS, PHY.PRESET_ORDER, PHY.getPreset(id)
 *
 * Funciona igual en navegador (window.PHY) y en Node (module.exports).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PHY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constantes del protocolo
   * ------------------------------------------------------------------ */

  var SR = 48000;
  var MAX_PAYLOAD = 200;
  var PROTOCOL_VERSION = 1;
  var PACKET_MARK = 0xA5;
  var PREAMBLE_LENGTH = 16;
  var MAX_REPS = 5;

  // Símbolos del preámbulo: permutación de 0..15 con buena autocorrelación.
  var PREAMBLE = [1, 9, 3, 11, 5, 13, 7, 15, 0, 8, 2, 10, 4, 12, 6, 14];

  // 16-FSK: separación de 3 bins de la FFT. N = muestras por símbolo.
  var PRESETS = {
    rapido: {
      id: 'rapido',
      name: 'Rápido',
      short: 'Rápido',
      N: 512,
      baseBin: 9,
      spacing: 3,
      symbolMs: 10.7,
      band: '0,84–5,06 kHz',
      bps: 187,
      description: 'Más rápido. Ideal a corta distancia y con poco ruido.'
    },
    normal: {
      id: 'normal',
      name: 'Normal',
      short: 'Normal',
      N: 1024,
      baseBin: 19,
      spacing: 3,
      symbolMs: 21.3,
      band: '0,89–3,00 kHz',
      bps: 94,
      description: 'Equilibrio entre velocidad, alcance y resistencia al ruido.'
    },
    alcance: {
      id: 'alcance',
      name: 'Alcance (10 m)',
      short: 'Alcance',
      N: 2048,
      baseBin: 21,
      spacing: 3,
      symbolMs: 42.7,
      band: '0,49–1,55 kHz',
      bps: 47,
      description: 'Banda estrecha, resistente al eco y al volumen bajo. Hasta ~10 m.'
    }
  };
  var PRESET_ORDER = ['normal', 'rapido', 'alcance'];

  // Símbolos máximos de un paquete de 200 bytes (205 bytes -> 410 nibbles).
  var MAX_SYMBOLS = Math.ceil(Math.ceil((3 + MAX_PAYLOAD + 2) * 8 / 4) / 4) * 8;

  // Pausa entre copias de un mismo paquete.
  var COPY_GAP_MS = 280;
  var LEAD_MS = 25;
  var TAIL_MS = 80;

  function getPreset(id) {
    if (!id) return PRESETS.normal;
    var key = String(id).toLowerCase();
    if (PRESETS[key]) return PRESETS[key];
    if (key === 'fast' || key === 'rapida' || key === 'rápido') return PRESETS.rapido;
    if (key === 'long' || key === 'long-range' || key === 'rango') return PRESETS.alcance;
    return PRESETS.normal;
  }

  /* ------------------------------------------------------------------ *
   * Utilidades de texto y bytes
   * ------------------------------------------------------------------ */

  var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  var decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

  function utf8Encode(text) {
    if (encoder) return encoder.encode(text);
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff) {
        var c2 = text.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(bytes);
  }

  function utf8Decode(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = Uint8Array.from(bytes);
    if (decoder) return decoder.decode(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
  }

  function normalizeText(text) {
    return String(text == null ? '' : text).normalize('NFC').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  }

  // Recorta a maxBytes UTF-8 sin partir ningún carácter.
  function limitText(text, maxBytes) {
    maxBytes = maxBytes || MAX_PAYLOAD;
    var full = utf8Encode(text);
    if (full.length <= maxBytes) return { text: text, bytes: full.length, truncated: false };
    var out = '';
    var used = 0;
    var chars = Array.from(text);
    for (var i = 0; i < chars.length; i++) {
      var size = utf8Encode(chars[i]).length;
      if (used + size > maxBytes) break;
      out += chars[i];
      used += size;
    }
    return { text: out, bytes: used, truncated: true };
  }

  /* ------------------------------------------------------------------ *
   * CRC-16/CCITT (poly 0x1021, init 0xFFFF)
   * ------------------------------------------------------------------ */

  function crc16(bytes, start, end) {
    var crc = 0xFFFF;
    start = start || 0;
    end = end == null ? bytes.length : end;
    for (var i = start; i < end; i++) {
      crc ^= (bytes[i] & 0xff) << 8;
      for (var b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xffff) : ((crc << 1) & 0xffff);
      }
    }
    return crc & 0xffff;
  }

  /* ------------------------------------------------------------------ *
   * Hamming(8,4) extendido
   * ------------------------------------------------------------------ */

  function hammingEncode(nibble) {
    var d0 = (nibble >> 3) & 1;
    var d1 = (nibble >> 2) & 1;
    var d2 = (nibble >> 1) & 1;
    var d3 = nibble & 1;
    var c0 = d0 ^ d1 ^ d3;
    var c1 = d0 ^ d2 ^ d3;
    var c3 = d1 ^ d2 ^ d3;
    var word = (c0) | (c1 << 1) | (d0 << 2) | (c3 << 3) | (d1 << 4) | (d2 << 5) | (d3 << 6);
    var parity = 0;
    for (var i = 0; i < 7; i++) parity ^= (word >> i) & 1;
    return (word | (parity << 7)) & 0xff;
  }

  function hammingDecode(word) {
    var w = word & 0xff;
    var parity = 0;
    for (var i = 0; i < 8; i++) parity ^= (w >> i) & 1;
    var s0 = ((w >> 0) & 1) ^ ((w >> 2) & 1) ^ ((w >> 4) & 1) ^ ((w >> 6) & 1);
    var s1 = ((w >> 1) & 1) ^ ((w >> 2) & 1) ^ ((w >> 5) & 1) ^ ((w >> 6) & 1);
    var s2 = ((w >> 3) & 1) ^ ((w >> 4) & 1) ^ ((w >> 5) & 1) ^ ((w >> 6) & 1);
    var syndrome = s0 | (s1 << 1) | (s2 << 2);
    var corrected = false;
    if (parity) {
      if (syndrome) w ^= 1 << (syndrome - 1);
      else w ^= 1 << 7;
      corrected = true;
    } else if (syndrome) {
      // Dos errores: detectable, no corregible.
      return { nibble: 0, ok: false, corrected: false };
    }
    var nibble = (((w >> 2) & 1) << 3) | (((w >> 4) & 1) << 2) | (((w >> 5) & 1) << 1) | ((w >> 6) & 1);
    return { nibble: nibble, ok: true, corrected: corrected };
  }

  /* ------------------------------------------------------------------ *
   * Paquete
   * ------------------------------------------------------------------ */

  function encodePacket(text) {
    var payload = utf8Encode(text);
    if (payload.length > MAX_PAYLOAD) throw new Error('Payload demasiado grande');
    var out = new Uint8Array(3 + payload.length + 2);
    out[0] = PACKET_MARK;
    out[1] = PROTOCOL_VERSION;
    out[2] = payload.length;
    out.set(payload, 3);
    var crc = crc16(out, 0, 3 + payload.length);
    out[3 + payload.length] = (crc >> 8) & 0xff;
    out[4 + payload.length] = crc & 0xff;
    return out;
  }

  function decodePacketBytes(bytes) {
    if (!bytes || bytes.length < 5) return null;
    if (bytes[0] !== PACKET_MARK) return null;
    if (bytes[1] !== PROTOCOL_VERSION) return null;
    var len = bytes[2];
    if (len > MAX_PAYLOAD) return null;
    var total = 3 + len + 2;
    if (bytes.length < total) return null;
    var expected = crc16(bytes, 0, 3 + len);
    var got = ((bytes[3 + len] & 0xff) << 8) | (bytes[4 + len] & 0xff);
    if (expected !== got) return null;
    var text = utf8Decode(bytes.slice(3, 3 + len));
    return { text: text, version: bytes[1] };
  }

  /* ------------------------------------------------------------------ *
   * Bits, símbolos, entrelazado
   * ------------------------------------------------------------------ */

  function bytesToBits(bytes) {
    var bits = new Array(bytes.length * 8);
    for (var i = 0; i < bytes.length; i++) {
      for (var b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
    }
    return bits;
  }

  function bytesToNibbles(bytes) {
    var bits = bytesToBits(bytes);
    while (bits.length % 4) bits.push(0);
    var nibbles = new Array(bits.length / 4);
    for (var i = 0; i < bits.length; i += 4) {
      nibbles[i / 4] = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    }
    return nibbles;
  }

  // Codifica los bytes en símbolos 16-FSK (nibble -> Hamming -> entrelazado).
  function bytesToSymbols(bytes) {
    var nibbles = bytesToNibbles(bytes);
    while (nibbles.length % 4) nibbles.push(0);
    var symbols = new Array(nibbles.length / 4 * 8);
    var out = 0;
    for (var i = 0; i < nibbles.length; i += 4) {
      var words = [
        hammingEncode(nibbles[i]),
        hammingEncode(nibbles[i + 1]),
        hammingEncode(nibbles[i + 2]),
        hammingEncode(nibbles[i + 3])
      ];
      var coded = new Array(32);
      var p = 0;
      for (var j = 0; j < 8; j++) {
        for (var w = 0; w < 4; w++) coded[p++] = (words[w] >> (7 - j)) & 1;
      }
      for (var s = 0; s < 8; s++) {
        var b0 = coded[s * 4], b1 = coded[s * 4 + 1], b2 = coded[s * 4 + 2], b3 = coded[s * 4 + 3];
        symbols[out++] = (b0 << 3) | (b1 << 2) | (b2 << 1) | b3;
      }
    }
    return symbols;
  }

  // Desentrelaza 8 símbolos (32 bits) -> 4 palabras Hamming -> 4 nibbles.
  function decodeSymbolBlock(bits) {
    var words = [0, 0, 0, 0];
    for (var j = 0; j < 8; j++) {
      for (var w = 0; w < 4; w++) words[w] |= bits[j * 4 + w] << (7 - j);
    }
    var nibbles = new Array(4);
    var ok = true;
    for (var k = 0; k < 4; k++) {
      var r = hammingDecode(words[k]);
      nibbles[k] = r.nibble;
      if (!r.ok) ok = false;
    }
    return { nibbles: nibbles, ok: ok };
  }

  // Acumula símbolos y reconstruye el paquete (usado en streaming).
  function PacketAssembler() {
    this.coded = new Array(32);
    this.codedCount = 0;
    this.bytes = [];
    this.currentByte = 0;
    this.bitCount = 0;
    this.symbols = 0;
    this.requiredSymbols = null;
    this.headerChecked = false;
    this.failed = false;
  }

  PacketAssembler.prototype.pushByteBit = function (bit) {
    this.currentByte = (this.currentByte << 1) | bit;
    this.bitCount++;
    if (this.bitCount === 8) {
      this.bytes.push(this.currentByte & 0xff);
      this.currentByte = 0;
      this.bitCount = 0;
    }
  };

  PacketAssembler.prototype.pushSymbol = function (tone) {
    if (this.failed) return { status: 'error' };
    this.symbols++;
    this.coded[this.codedCount++] = (tone >> 3) & 1;
    this.coded[this.codedCount++] = (tone >> 2) & 1;
    this.coded[this.codedCount++] = (tone >> 1) & 1;
    this.coded[this.codedCount++] = tone & 1;
    if (this.codedCount < 32) return null;
    this.codedCount = 0;
    var block = decodeSymbolBlock(this.coded);
    if (!block.ok) {
      this.failed = true;
      return { status: 'error', symbols: this.symbols };
    }
    for (var i = 0; i < 4; i++) {
      var nib = block.nibbles[i];
      this.pushByteBit((nib >> 3) & 1);
      this.pushByteBit((nib >> 2) & 1);
      this.pushByteBit((nib >> 1) & 1);
      this.pushByteBit(nib & 1);
    }
    if (!this.headerChecked && this.bytes.length >= 3) {
      this.headerChecked = true;
      if (this.bytes[0] !== PACKET_MARK || this.bytes[1] !== PROTOCOL_VERSION || this.bytes[2] > MAX_PAYLOAD) {
        this.failed = true;
        return { status: 'invalid', symbols: this.symbols };
      }
      var total = 3 + this.bytes[2] + 2;
      var nibblesNeeded = total * 2;
      var blocks = Math.ceil(nibblesNeeded / 4);
      this.requiredSymbols = blocks * 8;
    }
    if (this.requiredSymbols !== null && this.symbols >= this.requiredSymbols) {
      this.failed = true;
      var packet = decodePacketBytes(this.bytes);
      if (packet) return { status: 'ok', text: packet.text, symbols: this.symbols };
      return { status: 'crc', symbols: this.symbols };
    }
    return null;
  };

  /* ------------------------------------------------------------------ *
   * FFT radix-2 y tablas de tonos
   * ------------------------------------------------------------------ */

  var fftPlans = new Map();
  function getFftPlan(n) {
    var plan = fftPlans.get(n);
    if (plan) return plan;
    var bits = Math.log2(n) | 0;
    var rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var r = 0, x = i;
      for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    var half = n >> 1;
    var cos = new Float64Array(half);
    var sin = new Float64Array(half);
    for (var k = 0; k < half; k++) {
      cos[k] = Math.cos(2 * Math.PI * k / n);
      sin[k] = Math.sin(2 * Math.PI * k / n);
    }
    plan = { n: n, rev: rev, cos: cos, sin: sin };
    fftPlans.set(n, plan);
    return plan;
  }

  function fft(re, im, plan) {
    var n = plan.n, rev = plan.rev, cos = plan.cos, sin = plan.sin;
    for (var i = 0; i < n; i++) {
      var j = rev[i];
      if (j > i) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1;
      var step = n / size;
      for (var start = 0; start < n; start += size) {
        for (var k = 0, idx = 0; k < half; k++, idx += step) {
          var c = cos[idx], s = sin[idx];
          var a = start + k, b = a + half;
          var tre = re[b] * c + im[b] * s;
          var tim = im[b] * c - re[b] * s;
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
  }

  // Tablas de ondas por tono (una por preset) para sintetizar sin Math.sin.
  var waveCache = new Map();
  function getWaves(preset) {
    var cached = waveCache.get(preset.id);
    if (cached) return cached;
    var N = preset.N;
    var waves = new Array(16);
    for (var t = 0; t < 16; t++) {
      var bin = preset.baseBin + preset.spacing * t;
      var arr = new Float32Array(N);
      for (var n = 0; n < N; n++) arr[n] = Math.sin(2 * Math.PI * bin * n / N);
      waves[t] = arr;
    }
    waveCache.set(preset.id, waves);
    return waves;
  }

  function toneBins(preset) {
    if (!preset._bins) {
      var bins = new Array(16);
      for (var t = 0; t < 16; t++) bins[t] = preset.baseBin + preset.spacing * t;
      preset._bins = bins;
    }
    return preset._bins;
  }

  function toneFrequencies(preset) {
    var bins = toneBins(preset);
    return bins.map(function (b) { return b * SR / preset.N; });
  }

  /* ------------------------------------------------------------------ *
   * Síntesis
   * ------------------------------------------------------------------ */

  function renderAudio(text, options) {
    options = options || {};
    var preset = getPreset(options.preset);
    var reps = Math.max(1, Math.min(MAX_REPS, options.reps == null ? 2 : Math.round(options.reps)));
    var amplitude = options.amplitude == null ? 0.85 : Math.max(0, Math.min(1, options.amplitude));
    var limited = limitText(normalizeText(text), MAX_PAYLOAD);
    var bytes = encodePacket(limited.text);
    var symbols = bytesToSymbols(bytes);
    var waves = getWaves(preset);
    var N = preset.N;

    var lead = Math.round(LEAD_MS / 1000 * SR);
    var gap = Math.round(COPY_GAP_MS / 1000 * SR);
    var tail = Math.round(TAIL_MS / 1000 * SR);
    var copySamples = lead + (PREAMBLE_LENGTH + symbols.length) * N;
    var total = copySamples * reps + gap * (reps - 1) + tail;

    var out = new Float32Array(total);
    var pos = 0;
    for (var r = 0; r < reps; r++) {
      pos += lead;
      for (var p = 0; p < PREAMBLE_LENGTH; p++) {
        var w0 = waves[PREAMBLE[p]];
        for (var n0 = 0; n0 < N; n0++) out[pos + n0] = amplitude * w0[n0];
        pos += N;
      }
      for (var s = 0; s < symbols.length; s++) {
        var w = waves[symbols[s]];
        for (var n = 0; n < N; n++) out[pos + n] = amplitude * w[n];
        pos += N;
      }
      if (r < reps - 1) pos += gap;
    }
    return {
      samples: out,
      duration: total / SR,
      preset: preset.id,
      reps: reps,
      symbols: symbols.length,
      bytes: bytes.length,
      text: limited.text,
      truncated: limited.truncated
    };
  }

  /* ------------------------------------------------------------------ *
   * Duración estimada sin sintetizar
   * ------------------------------------------------------------------ */

  function estimateDuration(text, options) {
    options = options || {};
    var preset = getPreset(options.preset);
    var reps = Math.max(1, Math.min(MAX_REPS, Math.round(options.reps == null ? 2 : options.reps)));
    var limited = limitText(normalizeText(text), MAX_PAYLOAD);
    var bytes = 3 + utf8Encode(limited.text).length + 2;
    var nibbles = Math.ceil(bytes * 8 / 4);
    var symbols = Math.ceil(nibbles / 4) * 8;
    var lead = Math.round(LEAD_MS / 1000 * SR);
    var gap = Math.round(COPY_GAP_MS / 1000 * SR);
    var tail = Math.round(TAIL_MS / 1000 * SR);
    var copy = lead + (PREAMBLE_LENGTH + symbols) * preset.N;
    return (copy * reps + gap * (reps - 1) + tail) / SR;
  }

  /* ------------------------------------------------------------------ *
   * Remuestreo lineal (suficiente para 44,1 kHz <-> 48 kHz en banda de voz)
   * ------------------------------------------------------------------ */
  function resample(samples, from, to) {
    if (!samples || !samples.length) return new Float32Array(0);
    if (!from || !to || from === to) return samples instanceof Float32Array ? samples : Float32Array.from(samples);
    var ratio = to / from;
    var outLength = Math.max(1, Math.round(samples.length * ratio));
    var out = new Float32Array(outLength);
    var last = samples.length - 1;
    for (var i = 0; i < outLength; i++) {
      var pos = i / ratio;
      var i0 = Math.floor(pos);
      var frac = pos - i0;
      if (i0 >= last) {
        out[i] = samples[last];
      } else {
        out[i] = samples[i0] + (samples[i0 + 1] - samples[i0]) * frac;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * WAV PCM 16 bits mono
   * ------------------------------------------------------------------ */

  function encodeWav(samples, sampleRate) {
    sampleRate = sampleRate || SR;
    var n = samples.length;
    var buffer = new ArrayBuffer(44 + n * 2);
    var view = new DataView(buffer);
    function str(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    str(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, n * 2, true);
    var offset = 44;
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Uint8Array(buffer);
  }

  /* ------------------------------------------------------------------ *
   * Detección de preámbulo
   * ------------------------------------------------------------------ */

  function frameEnergies(samples, start, preset, plan, scratchRe, scratchIm, out) {
    var N = preset.N;
    var re = scratchRe, im = scratchIm;
    for (var i = 0; i < N; i++) { re[i] = samples[start + i]; im[i] = 0; }
    fft(re, im, plan);
    var bins = toneBins(preset);
    for (var t = 0; t < 16; t++) {
      var b = bins[t];
      out[t] = re[b] * re[b] + im[b] * im[b];
    }
    return out;
  }

  // Puntuación del preámbulo para el candidato c (frames c, c+2, ..., c+30).
  function preambleScore(ring, c) {
    var score = 0, min = 1, hits = 0;
    for (var k = 0; k < PREAMBLE_LENGTH; k++) {
      var e = ring[(c + 2 * k) % 31];
      if (!e) return null;
      var total = 0;
      for (var t = 0; t < 16; t++) total += e[t];
      var ratio = total > 1e-14 ? e[PREAMBLE[k]] / total : 0;
      score += ratio;
      if (ratio < min) min = ratio;
      if (ratio > 0.5) hits++;
    }
    return { score: score / PREAMBLE_LENGTH, min: min, hits: hits };
  }

  function looksLikePreamble(result) {
    return !!result && result.hits >= 9 && result.score >= 0.32 && result.min >= 0.08;
  }

  /* ------------------------------------------------------------------ *
   * Sincronización fina (ajuste a 1 muestra)
   * ------------------------------------------------------------------ */

  var trigCache = new Map();
  function getTrig(preset, tone) {
    var key = preset.id + ':' + tone;
    var trig = trigCache.get(key);
    if (trig) return trig;
    var N = preset.N;
    var bin = preset.baseBin + preset.spacing * tone;
    var cos = new Float32Array(N);
    var sin = new Float32Array(N);
    for (var n = 0; n < N; n++) {
      var a = 2 * Math.PI * bin * n / N;
      cos[n] = Math.cos(a);
      sin[n] = Math.sin(a);
    }
    trig = { cos: cos, sin: sin };
    trigCache.set(key, trig);
    return trig;
  }

  function toneEnergyAt(samples, start, preset, tone) {
    var N = preset.N;
    if (start < 0 || start + N > samples.length) return -1;
    var trig = getTrig(preset, tone);
    var cos = trig.cos, sin = trig.sin;
    var sr = 0, si = 0;
    for (var n = 0; n < N; n++) {
      var v = samples[start + n];
      sr += v * cos[n];
      si += v * sin[n];
    }
    return sr * sr + si * si;
  }

  // Energía total en los 16 bins de tono: máxima cuando la ventana coincide
  // exactamente con un símbolo (una sola frecuencia).
  function toneEnergySum(samples, start, preset, plan, re, im) {
    var N = preset.N;
    if (start < 0 || start + N > samples.length) return -1;
    for (var i = 0; i < N; i++) { re[i] = samples[start + i]; im[i] = 0; }
    fft(re, im, plan);
    var bins = toneBins(preset);
    var sum = 0;
    for (var t = 0; t < 16; t++) {
      var b = bins[t];
      sum += re[b] * re[b] + im[b] * im[b];
    }
    return sum;
  }

  // Busca el inicio real del preámbulo alrededor de coarseStart (±N/2).
  // Precisión final: 1 muestra.
  function fineSync(samples, coarseStart, preset) {
    var N = preset.N;
    var hop = N >> 1;
    var limit = hop + 8;
    var plan = getFftPlan(N);
    var re = new Float64Array(N);
    var im = new Float64Array(N);
    var bestDelta = 0;
    var best = -1;
    var d;
    for (d = -limit; d <= limit; d += 4) {
      var e = toneEnergySum(samples, coarseStart + d, preset, plan, re, im);
      if (e > best) { best = e; bestDelta = d; }
    }
    var fineStart = bestDelta - 6;
    var fineEnd = bestDelta + 6;
    var refinementTones = [0, 4, 8, 12];
    var best2 = -1;
    var bestDelta2 = bestDelta;
    for (d = fineStart; d <= fineEnd; d++) {
      if (d < -limit || d > limit) continue;
      var sum = 0;
      for (var k = 0; k < refinementTones.length; k++) {
        var v = toneEnergySum(samples, coarseStart + d + refinementTones[k] * N, preset, plan, re, im);
        if (v < 0) { sum = -1; break; }
        sum += v;
      }
      if (sum > best2) { best2 = sum; bestDelta2 = d; }
    }
    if (best2 <= 0) return null;
    return coarseStart + bestDelta2;
  }

  /* ------------------------------------------------------------------ *
   * Decodificación de símbolos y paquetes
   * ------------------------------------------------------------------ */

  function decodeSymbolTone(samples, start, preset, plan, scratchRe, scratchIm) {
    var N = preset.N;
    for (var i = 0; i < N; i++) { scratchRe[i] = samples[start + i]; scratchIm[i] = 0; }
    fft(scratchRe, scratchIm, plan);
    var bins = toneBins(preset);
    var bestTone = 0, bestEnergy = -1;
    for (var t = 0; t < 16; t++) {
      var b = bins[t];
      var e = scratchRe[b] * scratchRe[b] + scratchIm[b] * scratchIm[b];
      if (e > bestEnergy) { bestEnergy = e; bestTone = t; }
    }
    return bestTone;
  }

  function decodePacketAt(samples, symbolStart, preset) {
    var N = preset.N;
    var plan = getFftPlan(N);
    var re = new Float64Array(N);
    var im = new Float64Array(N);
    var asm = new PacketAssembler();
    for (var s = 0; s < MAX_SYMBOLS; s++) {
      var start = symbolStart + s * N;
      if (start + N > samples.length) {
        return { status: 'incomplete', symbols: asm.symbols, endSample: symbolStart + asm.symbols * N };
      }
      var tone = decodeSymbolTone(samples, start, preset, plan, re, im);
      var result = asm.pushSymbol(tone);
      if (result) {
        result.startSample = symbolStart;
        result.endSample = symbolStart + asm.symbols * N;
        return result;
      }
    }
    return { status: 'error', symbols: asm.symbols, endSample: symbolStart + asm.symbols * N };
  }

  /* ------------------------------------------------------------------ *
   * Escáner incremental por preset
   * ------------------------------------------------------------------ */

  function makeScanState(preset) {
    var ring = new Array(31);
    for (var i = 0; i < 31; i++) ring[i] = null;
    return {
      preset: preset,
      N: preset.N,
      hop: preset.N >> 1,
      plan: getFftPlan(preset.N),
      re: new Float64Array(preset.N),
      im: new Float64Array(preset.N),
      ring: ring,
      base: 0,
      nextFrame: 0,
      nextCandidate: 0,
      scratch: new Float32Array(16)
    };
  }

  function resetScanState(state, base) {
    state.base = base || 0;
    state.nextFrame = 0;
    state.nextCandidate = 0;
    for (var i = 0; i < 31; i++) state.ring[i] = null;
  }

  // Avanza el escáner hasta encontrar un preámbulo. Devuelve:
  //   { start }        candidato encontrado
  //   null             no hay más muestras por ahora
  //   'budget'         se agotó el tiempo del tick
  function stepScan(state, samples, deadline) {
    var N = state.N, hop = state.hop, ring = state.ring;
    var len = samples.length;
    var count = 0;
    while (true) {
      var frameStart = state.base + state.nextFrame * hop;
      if (frameStart + N > len) return null;
      var idx = state.nextFrame % 31;
      var energies = ring[idx];
      if (!energies) { energies = new Float32Array(16); ring[idx] = energies; }
      frameEnergies(samples, frameStart, state.preset, state.plan, state.re, state.im, energies);
      var j = state.nextFrame;
      state.nextFrame++;
      if (j >= 30) {
        var c = j - 30;
        if (c >= state.nextCandidate) {
          state.nextCandidate = c + 1;
          if (looksLikePreamble(preambleScore(ring, c))) {
            return { start: state.base + c * hop, frame: c, preset: state.preset };
          }
        }
      }
      count++;
      if ((count & 7) === 0 && now() > deadline) return 'budget';
    }
  }

  /* ------------------------------------------------------------------ *
   * Decodificador en streaming
   * ------------------------------------------------------------------ */

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  function LiveDecoder(options) {
    options = options || {};
    this.onPacket = typeof options.onPacket === 'function' ? options.onPacket : function () {};
    this.onSync = typeof options.onSync === 'function' ? options.onSync : function () {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : function () {};
    this.budgetMs = options.budgetMs == null ? 18 : options.budgetMs;
    this.capacity = 1 << 16;
    this.buffer = new Float32Array(this.capacity);
    this.length = 0;
    this.dropped = 0;
    this.scans = PRESET_ORDER.map(function (id) { return makeScanState(PRESETS[id]); });
    this.candidate = null;
    this.lastEmission = null;
    this.packets = [];
    this.budgetHits = 0;
    this.maxBufferSamples = 0;
  }

  LiveDecoder.prototype._ensure = function (extra) {
    var needed = this.length + extra;
    if (needed <= this.capacity) return;
    var cap = this.capacity;
    while (cap < needed) cap <<= 1;
    var next = new Float32Array(cap);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.capacity = cap;
  };

  LiveDecoder.prototype.append = function (chunk) {
    if (!chunk || !chunk.length) return;
    this._ensure(chunk.length);
    if (this.buffer.set) this.buffer.set(chunk, this.length);
    else for (var i = 0; i < chunk.length; i++) this.buffer[this.length + i] = chunk[i];
    this.length += chunk.length;
    if (this.length > this.maxBufferSamples) this.maxBufferSamples = this.length;
  };

  LiveDecoder.prototype._compact = function (keepFrom) {
    if (keepFrom == null || keepFrom <= 0) return;
    if (keepFrom > this.length) keepFrom = this.length;
    this.buffer.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.dropped += keepFrom;
    for (var i = 0; i < this.scans.length; i++) this.scans[i].base -= keepFrom;
    if (this.candidate) {
      this.candidate.start -= keepFrom;
      if (this.candidate.symbolStart != null) this.candidate.symbolStart -= keepFrom;
    }
  };

  LiveDecoder.prototype._resetScans = function (at) {
    if (at < 0) at = 0;
    this._compact(at);
    for (var i = 0; i < this.scans.length; i++) resetScanState(this.scans[i], 0);
    this.candidate = null;
  };

  LiveDecoder.prototype._absolute = function (sample) {
    return this.dropped + sample;
  };

  LiveDecoder.prototype._pendingKeep = function () {
    var keep = null;
    for (var i = 0; i < this.scans.length; i++) {
      var st = this.scans[i];
      if (st.nextCandidate < 0) continue;
      var pos = st.base + st.nextCandidate * st.hop;
      if (keep === null || pos < keep) keep = pos;
    }
    return keep;
  };

  LiveDecoder.prototype._finishPacket = function (result, startSample) {
    var absStart = this._absolute(startSample);
    var absEnd = this._absolute(result.endSample);
    var last = this.lastEmission;
    var duplicate = last && last.text === result.text && absStart >= last.start && absStart - last.end < SR * 1.2;
    if (duplicate) {
      last.end = Math.max(last.end, absEnd);
      return false;
    }
    var packet = {
      text: result.text,
      preset: this.candidate.preset.id,
      start: absStart,
      end: absEnd,
      symbols: result.symbols
    };
    this.lastEmission = { text: result.text, start: absStart, end: absEnd };
    this.packets.push(packet);
    return true;
  };

  LiveDecoder.prototype._failCandidate = function (resumeSample, reason) {
    var preset = this.candidate ? this.candidate.preset : null;
    this.candidate = null;
    this.onStatus({ type: reason || 'error', message: 'No se pudo decodificar la señal', preset: preset ? preset.id : null });
    this._resetScans(Math.max(0, resumeSample));
  };

  LiveDecoder.prototype._advanceCandidate = function (deadline, samples) {
    var cand = this.candidate;
    var preset = cand.preset;
    var N = preset.N;
    var available = samples.length;
    if (!cand.fine) {
      if (cand.start + 16 * N + (N >> 1) + 8 > available) return false;
      var aligned = fineSync(samples, cand.start, preset);
      if (aligned == null) {
        this._failCandidate(cand.start + (N >> 1), 'sync');
        return true;
      }
      cand.aligned = aligned;
      cand.symbolStart = aligned + 16 * N;
      cand.fine = true;
      cand.asm = new PacketAssembler();
      cand.plan = getFftPlan(N);
      cand.re = new Float64Array(N);
      cand.im = new Float64Array(N);
      cand.deadlineSample = cand.symbolStart + MAX_SYMBOLS * N + SR;
      this.onSync({ preset: preset.id, start: this._absolute(aligned) });
    }
    var asm = cand.asm;
    while (asm.symbols < MAX_SYMBOLS) {
      var symStart = cand.symbolStart + asm.symbols * N;
      if (symStart + N > available) {
        if (available >= cand.deadlineSample) {
          this._failCandidate(cand.symbolStart + asm.symbols * N, 'timeout');
          return true;
        }
        return false;
      }
      var tone = decodeSymbolTone(samples, symStart, preset, cand.plan, cand.re, cand.im);
      var result = asm.pushSymbol(tone);
      if (result) {
        if (result.status === 'ok') {
          result.endSample = cand.symbolStart + asm.symbols * N;
          var emitted = this._finishPacket(result, cand.start);
          if (emitted) {
            this.onPacket({
              text: result.text,
              preset: preset.id,
              start: this._absolute(cand.start),
              end: this._absolute(result.endSample)
            });
            this.onStatus({ type: 'received', message: 'Mensaje recibido', preset: preset.id });
          }
          var resume = result.endSample;
          this._resetScans(resume);
        } else {
          var resumeFail = cand.symbolStart + asm.symbols * N;
          if (result.status === 'invalid' || result.status === 'error') {
            // No hay trama válida: saltamos este candidato.
            resumeFail = Math.max(cand.start + (N >> 1), Math.min(resumeFail, available));
          }
          this._failCandidate(resumeFail, result.status);
        }
        return true;
      }
      if (now() > deadline) return false;
    }
    this._failCandidate(cand.symbolStart + asm.symbols * N, 'error');
    return true;
  };

  LiveDecoder.prototype.tick = function () {
    var deadline = now() + this.budgetMs;
    var guard = 0;
    while (guard++ < 400) {
      var samples = this.buffer.subarray(0, this.length);
      if (this.candidate) {
        var progressed = this._advanceCandidate(deadline, samples);
        if (!progressed) {
          this.budgetHits++;
          this._maybeCompact();
          return;
        }
        continue;
      }
      var found = null;
      for (var i = 0; i < this.scans.length && !found; i++) {
        var state = this.scans[i];
        var r = stepScan(state, samples, deadline);
        if (r === 'budget') {
          this.budgetHits++;
          this._maybeCompact();
          return;
        }
        if (r) found = r;
      }
      if (!found) {
        this._maybeCompact();
        return;
      }
      this.candidate = { preset: found.preset, start: found.start, fine: false };
      this.onSync({ preset: found.preset.id, start: this._absolute(found.start) });
    }
    this._maybeCompact();
  };

  LiveDecoder.prototype._maybeCompact = function () {
    if (this.candidate) return;
    var keep = this._pendingKeep();
    if (keep == null) return;
    var minKeep = 8 * 2048;
    if (keep < minKeep) return;
    this._compact(keep);
  };

  // Compatibilidad con la API pedida: trim() libera audio ya procesado.
  LiveDecoder.prototype.trim = function () {
    this._maybeCompact();
    return this.length;
  };

  LiveDecoder.prototype.reset = function () {
    this.length = 0;
    this.dropped = 0;
    this.candidate = null;
    this.lastEmission = null;
    this.packets = [];
    for (var i = 0; i < this.scans.length; i++) resetScanState(this.scans[i], 0);
  };

  /* ------------------------------------------------------------------ *
   * Decodificación de un buffer completo (offline)
   * ------------------------------------------------------------------ */

  function decodeBuffer(samples, options) {
    options = options || {};
    var data = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    if (options.sampleRate && options.sampleRate !== SR) {
      data = resample(data, options.sampleRate, SR);
    }
    var order;
    if (options.preset) {
      order = [getPreset(options.preset)];
    } else {
      order = PRESET_ORDER.map(function (id) { return PRESETS[id]; });
    }

    var results = [];
    var lastEmission = null;
    var cursor = 0;

    while (cursor < data.length) {
      var found = null;
      for (var i = 0; i < order.length && !found; i++) {
        var state = makeScanState(order[i]);
        state.base = cursor;
        var r = stepScan(state, data, Infinity);
        if (r && r !== 'budget') found = r;
      }
      if (!found) break;

      var preset = found.preset;
      var N = preset.N;
      if (found.start + 16 * N + (N >> 1) + 8 > data.length) break;
      var aligned = fineSync(data, found.start, preset);
      if (aligned == null) {
        cursor = found.start + (N >> 1);
        continue;
      }
      var decoded = decodePacketAt(data, aligned + 16 * N, preset);
      if (decoded.status === 'ok') {
        var absStart = aligned;
        var absEnd = decoded.endSample;
        var duplicate = lastEmission && lastEmission.text === decoded.text && absStart >= lastEmission.start && absStart - lastEmission.end < SR * 1.2;
        if (duplicate) {
          lastEmission.end = Math.max(lastEmission.end, absEnd);
        } else {
          lastEmission = { text: decoded.text, start: absStart, end: absEnd };
          results.push({ text: decoded.text, preset: preset.id, start: absStart, end: absEnd });
        }
        cursor = Math.max(cursor + 1, absEnd);
      } else if (decoded.status === 'incomplete') {
        break;
      } else {
        var next = decoded.endSample && decoded.endSample > found.start ? decoded.endSample : found.start + (N >> 1);
        cursor = Math.max(found.start + (N >> 1), Math.min(next, data.length));
      }
    }
    results.sort(function (a, b) { return a.start - b.start; });
    return results;
  }

  /* ------------------------------------------------------------------ *
   * Exportación
   * ------------------------------------------------------------------ */

  return {
    SR: SR,
    MAX_PAYLOAD: MAX_PAYLOAD,
    PRESETS: PRESETS,
    PRESET_ORDER: PRESET_ORDER,
    PREAMBLE: PREAMBLE,
    getPreset: getPreset,
    renderAudio: renderAudio,
    estimateDuration: estimateDuration,
    decodeBuffer: decodeBuffer,
    LiveDecoder: LiveDecoder,
    encodeWav: encodeWav,
    resample: resample,
    normalizeText: normalizeText,
    limitText: limitText,
    toneFrequencies: toneFrequencies,
    internals: {
      crc16: crc16,
      hammingEncode: hammingEncode,
      hammingDecode: hammingDecode,
      encodePacket: encodePacket,
      decodePacketBytes: decodePacketBytes,
      bytesToSymbols: bytesToSymbols,
      decodeSymbolBlock: decodeSymbolBlock,
      PacketAssembler: PacketAssembler,
      fft: fft,
      getFftPlan: getFftPlan,
      MAX_SYMBOLS: MAX_SYMBOLS
    }
  };
});
