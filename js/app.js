/*
 * Susurro · aplicación de chat por sonido.
 * Interfaz, emisión, micrófono, transcripción de archivos y ajustes.
 */
(function () {
  'use strict';

  var PHY = window.PHY;
  if (!PHY) {
    console.error('No se cargó js/phy.js');
    return;
  }

  var STORAGE_KEY = 'susurro:ajustes';
  var DUPLICATE_WINDOW_MS = 15000;
  var MAX_INPUT_PX = 96;
  var ECHO_MARGIN_MS = 3000;

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    app: $('app'),
    chat: $('chat'),
    messages: $('messages'),
    emptyState: $('emptyState'),
    statusText: $('statusText'),
    statusDot: $('statusDot'),
    levelFill: $('levelFill'),
    connectionText: $('connectionText'),
    connectionLabel: $('connectionLabel'),
    btnSettings: $('btnSettings'),
    btnCloseSettings: $('btnCloseSettings'),
    btnListen: $('btnListen'),
    listenLabel: document.querySelector('.listen-label'),
    composer: $('composer'),
    inputText: $('inputText'),
    btnSend: $('btnSend'),
    btnClip: $('btnClip'),
    fileInput: $('fileInput'),
    settingsPanel: $('settingsPanel'),
    settingsNote: $('settingsNote'),
    profileRapido: $('profileRapido'),
    profileNormal: $('profileNormal'),
    profileAlcance: $('profileAlcance'),
    rangeReps: $('rangeReps'),
    rangeVolume: $('rangeVolume'),
    repsValue: $('repsValue'),
    volumeValue: $('volumeValue'),
    toasts: $('toasts')
  };

  var state = {
    settings: { preset: 'normal', reps: 2, volume: 85 },
    seq: 0,
    messages: [],
    incoming: [],
    emissions: new Map(),
    audioCtx: null,
    playing: null,
    lastEmitted: null,
    statusTimer: 0,
    transcribing: false,
    mic: {
      active: false,
      busy: false,
      ctx: null,
      stream: null,
      source: null,
      node: null,
      sink: null,
      decoder: null,
      interval: 0,
      raf: 0,
      level: 0,
      rate: PHY.SR
    }
  };

  /* ------------------------------------------------------------------ *
   * Utilidades de interfaz
   * ------------------------------------------------------------------ */

  function formatTime(date) {
    try {
      return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(date || new Date());
    } catch (e) {
      var d = date || new Date();
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
  }

  function formatSeconds(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    var rounded = Math.round(seconds * 10) / 10;
    var text = rounded >= 10 ? String(Math.round(rounded)) : String(rounded);
    return text.replace('.', ',') + ' s';
  }

  function setStatus(text, kind) {
    els.statusText.textContent = text;
    els.statusDot.className = 'status-dot' + (kind ? ' ' + kind : '');
  }

  function baseStatus() {
    if (state.mic.active) setStatus('Escuchando…', 'listening');
    else setStatus('Micrófono apagado', '');
  }

  function scheduleStatusRevert(delay) {
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(function () {
      if (state.mic.active) setStatus('Escuchando…', 'listening');
      else setStatus('Micrófono apagado', '');
    }, delay == null ? 2800 : delay);
  }

  function toast(message, type) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = message;
    els.toasts.appendChild(el);
    while (els.toasts.children.length > 3) els.toasts.removeChild(els.toasts.firstChild);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 260);
    }, 3400);
  }

  function scrollToBottom() {
    requestAnimationFrame(function () {
      els.chat.scrollTop = els.chat.scrollHeight;
    });
  }

  function hideEmptyState() {
    if (!els.emptyState.classList.contains('hidden')) els.emptyState.classList.add('hidden');
  }

  function updateConnection() {
    var online = navigator.onLine !== false;
    els.connectionLabel.textContent = online ? 'En línea' : 'Sin conexión';
    els.connectionText.classList.toggle('offline', !online);
  }

  function autoGrow() {
    var input = els.inputText;
    input.style.height = 'auto';
    var height = Math.min(MAX_INPUT_PX, Math.max(44, input.scrollHeight));
    input.style.height = height + 'px';
    input.style.overflowY = input.scrollHeight > MAX_INPUT_PX ? 'auto' : 'hidden';
  }

  /* ------------------------------------------------------------------ *
   * Ajustes
   * ------------------------------------------------------------------ */

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      var preset = PHY.getPreset(saved && saved.preset);
      if (saved && saved.preset && PHY.PRESETS[preset.id]) state.settings.preset = preset.id;
      if (saved && saved.reps != null) {
        var reps = Math.round(Number(saved.reps));
        if (reps >= 1 && reps <= 5) state.settings.reps = reps;
      }
      if (saved && saved.volume != null) {
        var vol = Math.round(Number(saved.volume));
        if (vol >= 10 && vol <= 100) state.settings.volume = vol;
      }
    } catch (e) { /* sin ajustes guardados */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch (e) { /* almacenamiento no disponible */ }
  }

  function syncSettingsUI() {
    var s = state.settings;
    els.profileRapido.checked = s.preset === 'rapido';
    els.profileNormal.checked = s.preset === 'normal';
    els.profileAlcance.checked = s.preset === 'alcance';
    els.rangeReps.value = String(s.reps);
    els.rangeVolume.value = String(s.volume);
    els.repsValue.textContent = String(s.reps);
    els.volumeValue.textContent = String(s.volume);
    updateSettingsNote();
  }

  function updateSettingsNote() {
    var preset = PHY.getPreset(state.settings.preset);
    var text = els.inputText.value || 'Mensaje de ejemplo';
    var seconds = PHY.estimateDuration(text, {
      preset: preset.id,
      reps: state.settings.reps
    });
    els.settingsNote.innerHTML =
      '<strong>' + preset.name + '</strong> · ' + preset.band + ' · ' + preset.bps + ' bits/s. ' +
      preset.description + ' Emisión estimada: <strong>' + formatSeconds(seconds) + '</strong>.';
  }

  function onSettingsChanged() {
    saveSettings();
    syncSettingsUI();
  }

  els.profileRapido.addEventListener('change', function () {
    if (!els.profileRapido.checked) return;
    state.settings.preset = 'rapido';
    onSettingsChanged();
  });

  els.profileNormal.addEventListener('change', function () {
    if (!els.profileNormal.checked) return;
    state.settings.preset = 'normal';
    onSettingsChanged();
  });

  els.profileAlcance.addEventListener('change', function () {
    if (!els.profileAlcance.checked) return;
    state.settings.preset = 'alcance';
    state.settings.reps = 3;
    onSettingsChanged();
  });

  els.rangeReps.addEventListener('input', function () {
    var value = Math.round(Number(els.rangeReps.value));
    state.settings.reps = Math.min(5, Math.max(1, value));
    els.repsValue.textContent = String(state.settings.reps);
    updateSettingsNote();
    saveSettings();
  });

  els.rangeVolume.addEventListener('input', function () {
    var value = Math.round(Number(els.rangeVolume.value));
    state.settings.volume = Math.min(100, Math.max(10, value));
    els.volumeValue.textContent = String(state.settings.volume);
    saveSettings();
  });

  function openSettings() {
    els.settingsPanel.classList.add('open');
    els.settingsPanel.setAttribute('aria-hidden', 'false');
    els.btnSettings.setAttribute('aria-expanded', 'true');
    updateSettingsNote();
  }

  function closeSettings() {
    els.settingsPanel.classList.remove('open');
    els.settingsPanel.setAttribute('aria-hidden', 'true');
    els.btnSettings.setAttribute('aria-expanded', 'false');
  }

  els.btnSettings.addEventListener('click', function () {
    if (els.settingsPanel.classList.contains('open')) closeSettings();
    else openSettings();
  });
  els.btnCloseSettings.addEventListener('click', closeSettings);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && els.settingsPanel.classList.contains('open')) closeSettings();
  });

  document.addEventListener('pointerdown', function (event) {
    if (!els.settingsPanel.classList.contains('open')) return;
    if (els.settingsPanel.contains(event.target) || els.btnSettings.contains(event.target)) return;
    closeSettings();
  });

  /* ------------------------------------------------------------------ *
   * Emisión de audio
   * ------------------------------------------------------------------ */

  function getPlayContext() {
    if (!state.audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Sin Web Audio');
      state.audioCtx = new Ctx({ sampleRate: PHY.SR, latencyHint: 'interactive' });
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(function () {});
    }
    return state.audioCtx;
  }

  function stopPlayback() {
    var playing = state.playing;
    if (!playing) return;
    try {
      playing.source.onended = null;
      playing.source.stop();
    } catch (e) { /* ya terminó */ }
    finishPlayback(playing);
  }

  function finishPlayback(playing) {
    if (state.playing !== playing) return;
    cancelAnimationFrame(playing.raf);
    state.playing = null;
    if (!playing.bubble) return;
    playing.bubble.classList.remove('emitting');
    var stateEl = playing.bubble.querySelector('.msg-state');
    if (stateEl) stateEl.textContent = 'emitido';
    var fill = playing.bubble.querySelector('.msg-progress span');
    if (fill) fill.style.width = '100%';
  }

  function playEmission(emission, bubble) {
    stopPlayback();
    var ctx;
    try {
      ctx = getPlayContext();
    } catch (e) {
      toast('Este navegador no puede reproducir audio.', 'error');
      if (bubble) {
        bubble.classList.remove('emitting');
        var s = bubble.querySelector('.msg-state');
        if (s) s.textContent = 'error';
      }
      return;
    }
    var samples = emission.samples;
    if (ctx.sampleRate !== PHY.SR) {
      samples = PHY.resample(samples, PHY.SR, ctx.sampleRate);
    }
    var buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    if (buffer.copyToChannel) buffer.copyToChannel(samples, 0);
    else buffer.getChannelData(0).set(samples);

    var source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    var playing = {
      source: source,
      emission: emission,
      bubble: bubble || null,
      started: 0,
      raf: 0,
      duration: emission.duration
    };
    state.playing = playing;

    if (bubble) {
      bubble.classList.add('emitting');
      var stateEl = bubble.querySelector('.msg-state');
      if (stateEl) stateEl.textContent = 'reproduciendo…';
      var fill = bubble.querySelector('.msg-progress span');
      if (fill) fill.style.width = '0%';
    }

    state.lastEmitted = {
      text: emission.text,
      until: Date.now() + emission.duration * 1000 + ECHO_MARGIN_MS
    };

    source.onended = function () { finishPlayback(playing); };
    playing.started = performance.now();

    function frame() {
      if (state.playing !== playing) return;
      var elapsed = (performance.now() - playing.started) / 1000;
      var pct = Math.min(100, Math.max(0, elapsed / emission.duration * 100));
      var bar = playing.bubble && playing.bubble.querySelector('.msg-progress span');
      if (bar) bar.style.width = pct.toFixed(1) + '%';
      playing.raf = requestAnimationFrame(frame);
    }
    playing.raf = requestAnimationFrame(frame);

    try {
      source.start(0);
    } catch (e) {
      finishPlayback(playing);
      toast('No se pudo emitir el mensaje.', 'error');
    }
  }

  /* ------------------------------------------------------------------ *
   * Burbujas
   * ------------------------------------------------------------------ */

  function buildOutgoing(text, emission) {
    var id = ++state.seq;
    var article = document.createElement('article');
    article.className = 'msg';
    article.dataset.direction = 'out';
    article.dataset.id = 'm' + id;
    article.setAttribute('role', 'listitem');

    var p = document.createElement('p');
    p.className = 'msg-text';
    p.textContent = text;
    article.appendChild(p);

    var meta = document.createElement('div');
    meta.className = 'msg-meta';

    var duration = document.createElement('span');
    duration.className = 'msg-duration';
    duration.textContent = formatSeconds(emission.duration);
    meta.appendChild(duration);

    var stateEl = document.createElement('span');
    stateEl.className = 'msg-state';
    stateEl.textContent = 'reproduciendo…';
    meta.appendChild(stateEl);

    var time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(new Date());
    meta.appendChild(time);

    var replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'btn-replay';
    replay.setAttribute('aria-label', 'Volver a emitir este mensaje');
    replay.title = 'Volver a emitir';
    replay.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v5h5M4.5 14a8 8 0 1 0 2-7.5L4 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
    replay.addEventListener('click', function () {
      playEmission(emission, article);
    });
    meta.appendChild(replay);

    article.appendChild(meta);

    var progress = document.createElement('div');
    progress.className = 'msg-progress';
    progress.appendChild(document.createElement('span'));
    article.appendChild(progress);

    els.messages.appendChild(article);
    state.messages.push({ id: 'm' + id, direction: 'out', text: text, time: Date.now() });
    state.emissions.set('m' + id, emission);
    hideEmptyState();
    scrollToBottom();
    return article;
  }

  function findIncomingDuplicate(text) {
    var now = Date.now();
    for (var i = state.incoming.length - 1; i >= 0; i--) {
      var entry = state.incoming[i];
      if (!entry.el.isConnected) {
        state.incoming.splice(i, 1);
        continue;
      }
      if (entry.text === text && now - entry.time < DUPLICATE_WINDOW_MS) return entry;
    }
    return null;
  }

  function buildIncoming(text, options) {
    options = options || {};
    var now = new Date();
    var duplicate = findIncomingDuplicate(text);
    if (duplicate) {
      duplicate.count++;
      duplicate.time = now.getTime();
      var countEl = duplicate.el.querySelector('.msg-count');
      if (countEl) {
        countEl.textContent = '×' + duplicate.count;
        countEl.classList.add('show');
      }
      var timeEl = duplicate.el.querySelector('.msg-time');
      if (timeEl) timeEl.textContent = formatTime(now);
      return duplicate.el;
    }

    var id = ++state.seq;
    var article = document.createElement('article');
    article.className = 'msg';
    article.dataset.direction = 'in';
    article.dataset.label = options.label === 'transcrito' ? 'transcrito' : 'mic';
    article.dataset.id = 'm' + id;
    article.setAttribute('role', 'listitem');

    var label = document.createElement('span');
    label.className = 'msg-label';
    if (options.label === 'transcrito') {
      label.textContent = 'audio transcrito';
    } else {
      var preset = PHY.getPreset(options.preset || state.settings.preset);
      label.textContent = 'recibido · ' + preset.name;
    }
    article.appendChild(label);

    var p = document.createElement('p');
    p.className = 'msg-text';
    p.textContent = text;
    article.appendChild(p);

    var meta = document.createElement('div');
    meta.className = 'msg-meta';

    var count = document.createElement('span');
    count.className = 'msg-count';
    meta.appendChild(count);

    var time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(now);
    meta.appendChild(time);

    var received = document.createElement('span');
    received.className = 'msg-received';
    received.textContent = '✓✓';
    received.title = 'Recibido';
    meta.appendChild(received);

    article.appendChild(meta);
    els.messages.appendChild(article);

    var entry = { el: article, text: text, time: now.getTime(), count: 1 };
    state.incoming.push(entry);
    state.messages.push({ id: 'm' + id, direction: 'in', text: text, time: now.getTime() });
    hideEmptyState();
    scrollToBottom();
    return article;
  }

  function addIncoming(text, options) {
    options = options || {};
    var clean = PHY.normalizeText(text);
    if (!clean) return null;
    if (state.lastEmitted && state.lastEmitted.text === clean && Date.now() < state.lastEmitted.until) {
      // Eco del propio altavoz capturado por el micrófono.
      return null;
    }
    return buildIncoming(clean, options);
  }

  /* ------------------------------------------------------------------ *
   * Envío
   * ------------------------------------------------------------------ */

  function sendCurrentMessage() {
    var raw = els.inputText.value;
    var normalized = PHY.normalizeText(raw);
    if (!normalized) {
      toast('Escribe un mensaje antes de enviar.');
      els.inputText.focus();
      return;
    }
    var limited = PHY.limitText(normalized, PHY.MAX_PAYLOAD);
    if (limited.truncated) {
      toast('El mensaje se recortó a ' + PHY.MAX_PAYLOAD + ' bytes.', 'error');
    }
    els.inputText.value = '';
    autoGrow();
    updateSettingsNote();

    var rendered;
    try {
      rendered = PHY.renderAudio(limited.text, {
        preset: state.settings.preset,
        reps: state.settings.reps,
        amplitude: state.settings.volume / 100
      });
    } catch (e) {
      toast('No se pudo preparar el audio del mensaje.', 'error');
      return;
    }

    var emission = {
      text: limited.text,
      samples: rendered.samples,
      duration: rendered.duration,
      preset: rendered.preset,
      reps: rendered.reps
    };

    var bubble = buildOutgoing(limited.text, emission);
    playEmission(emission, bubble);
  }

  els.composer.addEventListener('submit', function (event) {
    event.preventDefault();
    sendCurrentMessage();
  });

  els.inputText.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });

  els.inputText.addEventListener('input', function () {
    autoGrow();
    updateSettingsNote();
  });

  /* ------------------------------------------------------------------ *
   * Micrófono
   * ------------------------------------------------------------------ */

  var WORKLET_CODE = [
    'class SusurroMic extends AudioWorkletProcessor {',
    '  process(inputs) {',
    '    const input = inputs[0];',
    '    const channel = input && input[0];',
    '    if (channel) this.port.postMessage(channel.slice(0));',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("susurro-mic", SusurroMic);'
  ].join('\n');

  function isSecureForMic() {
    return window.isSecureContext === true ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      location.hostname === '[::1]';
  }

  function micErrorMessage(error) {
    var name = error && error.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return 'Permiso de micrófono denegado. Actívalo en los ajustes del navegador.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'No se encontró ningún micrófono.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return 'El micrófono está ocupado por otra aplicación.';
    }
    return 'No se pudo activar el micrófono. Revisa los permisos.';
  }

  function setListenUI(active, busy) {
    els.btnListen.classList.toggle('active', !!active);
    els.btnListen.setAttribute('aria-pressed', active ? 'true' : 'false');
    els.btnListen.disabled = !!busy;
    els.btnListen.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (els.listenLabel) els.listenLabel.textContent = busy ? 'Conectando…' : (active ? 'Escuchando' : 'Escuchar');
  }

  function pushMicSamples(data, rate) {
    var mic = state.mic;
    if (!mic.active || !mic.decoder) return;
    var samples = data;
    if (!(samples instanceof Float32Array)) samples = Float32Array.from(data);
    if (rate && rate !== PHY.SR) samples = PHY.resample(samples, rate, PHY.SR);
    if (!samples.length) return;
    var sum = 0;
    for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    var rms = Math.sqrt(sum / samples.length);
    mic.level = Math.max(mic.level * 0.85, Math.min(1, rms));
    try {
      mic.decoder.append(samples);
    } catch (e) { /* buffer descartado */ }
  }

  function micLevelLoop() {
    if (!state.mic.active) return;
    state.mic.level *= 0.9;
    var pct = Math.max(2, Math.min(100, state.mic.level * 320));
    els.levelFill.style.width = pct.toFixed(1) + '%';
    state.mic.raf = requestAnimationFrame(micLevelLoop);
  }

  function handleMicPacket(packet) {
    var added = addIncoming(packet.text, { label: 'mic', preset: packet.preset });
    if (!added) return;
    setStatus('Mensaje recibido', 'received');
    scheduleStatusRevert();
    if (navigator.vibrate) {
      try { navigator.vibrate(35); } catch (e) { /* opcional */ }
    }
  }

  function createWorkletNode(ctx) {
    if (!ctx.audioWorklet || !ctx.audioWorklet.addModule) return Promise.reject(new Error('sin worklet'));
    var url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
    return ctx.audioWorklet.addModule(url).then(function () {
      URL.revokeObjectURL(url);
      return new AudioWorkletNode(ctx, 'susurro-mic', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
    }, function (err) {
      URL.revokeObjectURL(url);
      throw err;
    });
  }

  async function startMic() {
    if (state.mic.active || state.mic.busy) return;
    if (!isSecureForMic()) {
      setStatus('El micrófono requiere HTTPS o localhost', 'error');
      toast('El micrófono requiere HTTPS o localhost.', 'error');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Micrófono no disponible', 'error');
      toast('Este navegador no permite usar el micrófono.', 'error');
      return;
    }

    state.mic.busy = true;
    setListenUI(false, true);
    setStatus('Solicitando micrófono…', 'syncing');

    var stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        },
        video: false
      });

      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx({ sampleRate: PHY.SR, latencyHint: 'interactive' });
      if (ctx.state === 'suspended') await ctx.resume();

      var source = ctx.createMediaStreamSource(stream);
      var sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);

      var decoder = new PHY.LiveDecoder({
        onPacket: handleMicPacket,
        onSync: function () {
          if (!state.mic.active) return;
          setStatus('Señal detectada · sincronizando', 'syncing');
        },
        onStatus: function (info) {
          if (!state.mic.active) return;
          if (info.type === 'crc' || info.type === 'error' || info.type === 'invalid' || info.type === 'timeout') {
            setStatus('Señal incompleta · sigue escuchando', 'syncing');
            scheduleStatusRevert(2200);
          }
        }
      });

      var node = null;
      try {
        node = await createWorkletNode(ctx);
        node.port.onmessage = function (event) {
          pushMicSamples(event.data, ctx.sampleRate);
        };
      } catch (workletError) {
        node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = function (event) {
          var channel = event.inputBuffer.getChannelData(0);
          pushMicSamples(channel.slice(0), ctx.sampleRate);
        };
      }

      source.connect(node);
      node.connect(sink);

      var mic = state.mic;
      mic.active = true;
      mic.busy = false;
      mic.ctx = ctx;
      mic.stream = stream;
      mic.source = source;
      mic.node = node;
      mic.sink = sink;
      mic.decoder = decoder;
      mic.rate = ctx.sampleRate;
      mic.level = 0;
      mic.interval = setInterval(function () {
        if (!mic.active || !mic.decoder) return;
        try { mic.decoder.tick(); } catch (e) { /* seguimos escuchando */ }
      }, 170);
      mic.raf = requestAnimationFrame(micLevelLoop);

      if (mic.stream.getAudioTracks) {
        mic.stream.getAudioTracks().forEach(function (track) {
          track.addEventListener('ended', function () {
            if (state.mic.active) {
              stopMic();
              toast('El micrófono se desconectó.', 'error');
            }
          });
        });
      }

      setListenUI(true, false);
      setStatus('Escuchando…', 'listening');
      toast('Micrófono activo. Escuchando mensajes…', 'ok');
    } catch (error) {
      if (stream) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* nada */ }
      }
      state.mic.busy = false;
      setListenUI(false, false);
      var message = micErrorMessage(error);
      setStatus(message, 'error');
      toast(message, 'error');
    }
  }

  function stopMic() {
    var mic = state.mic;
    clearInterval(mic.interval);
    cancelAnimationFrame(mic.raf);
    mic.interval = 0;
    mic.raf = 0;
    try { if (mic.node && mic.node.port) mic.node.port.onmessage = null; } catch (e) { /* nada */ }
    try { if (mic.node && mic.node.onaudioprocess !== undefined) mic.node.onaudioprocess = null; } catch (e) { /* nada */ }
    try { if (mic.source) mic.source.disconnect(); } catch (e) { /* nada */ }
    try { if (mic.node) mic.node.disconnect(); } catch (e) { /* nada */ }
    try { if (mic.sink) mic.sink.disconnect(); } catch (e) { /* nada */ }
    try { if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* nada */ }
    try { if (mic.ctx && mic.ctx.close) mic.ctx.close().catch(function () {}); } catch (e) { /* nada */ }
    if (mic.decoder) mic.decoder.reset();
    mic.active = false;
    mic.busy = false;
    mic.ctx = null;
    mic.stream = null;
    mic.source = null;
    mic.node = null;
    mic.sink = null;
    mic.decoder = null;
    mic.level = 0;
    els.levelFill.style.width = '2%';
    setListenUI(false, false);
    setStatus('Micrófono apagado', '');
  }

  els.btnListen.addEventListener('click', function () {
    if (state.mic.busy) return;
    if (state.mic.active) stopMic();
    else startMic();
  });

  /* ------------------------------------------------------------------ *
   * Transcripción de archivos
   * ------------------------------------------------------------------ */

  function decodeAudioFile(arrayBuffer) {
    return new Promise(function (resolve, reject) {
      var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Ctx) {
        reject(new Error('sin-offline'));
        return;
      }
      var ctx;
      try {
        ctx = new Ctx(1, 1, PHY.SR);
      } catch (e) {
        try { ctx = new Ctx(1, 1, 44100); } catch (e2) { reject(new Error('sin-offline')); return; }
      }
      var copy = arrayBuffer.slice(0);
      var result;
      try {
        result = ctx.decodeAudioData(copy, resolve, reject);
      } catch (e) {
        reject(e);
      }
      if (result && typeof result.then === 'function') {
        result.then(resolve, reject);
      }
    });
  }

  async function transcribeFile(file) {
    if (!file || state.transcribing) return;
    state.transcribing = true;
    var micWasActive = state.mic.active;
    setStatus('Procesando audio…', 'syncing');
    toast('Procesando audio…');
    try {
      var arrayBuffer = await file.arrayBuffer();
      var audioBuffer = await decodeAudioFile(arrayBuffer);
      var data = audioBuffer.getChannelData(0);
      var rate = audioBuffer.sampleRate || PHY.SR;
      if (rate !== PHY.SR) {
        data = PHY.resample(data, rate, PHY.SR);
        rate = PHY.SR;
      }
      // Deja pintar el estado antes de decodificar (puede tardar).
      await new Promise(function (resolve) { setTimeout(resolve, 20); });
      var results = PHY.decodeBuffer(data, { sampleRate: rate });
      if (!results.length) {
        toast('El archivo no contiene ningún mensaje de Susurro.', 'error');
        setStatus(micWasActive ? 'Escuchando…' : 'Micrófono apagado', micWasActive ? 'listening' : '');
        return;
      }
      var added = 0;
      for (var i = 0; i < results.length; i++) {
        if (addIncoming(results[i].text, { label: 'transcrito', preset: results[i].preset })) added++;
      }
      if (added === 0) {
        toast('El audio solo contenía ecos del propio dispositivo.', 'error');
      } else {
        toast(added === 1 ? 'Audio transcrito' : added + ' mensajes transcritos', 'ok');
      }
      setStatus('Mensaje recibido', 'received');
      scheduleStatusRevert();
    } catch (error) {
      var message = 'No se pudo leer el archivo de audio.';
      if (error && (error.name === 'EncodingError' || error.message === 'sin-offline')) {
        message = 'Formato de audio no compatible.';
      }
      toast(message, 'error');
      setStatus(micWasActive ? 'Escuchando…' : 'Micrófono apagado', micWasActive ? 'listening' : '');
    } finally {
      state.transcribing = false;
      els.fileInput.value = '';
    }
  }

  els.btnClip.addEventListener('click', function () {
    els.fileInput.click();
  });

  els.fileInput.addEventListener('change', function () {
    var file = els.fileInput.files && els.fileInput.files[0];
    if (file) transcribeFile(file);
  });

  /* ------------------------------------------------------------------ *
   * Arranque
   * ------------------------------------------------------------------ */

  function init() {
    loadSettings();
    syncSettingsUI();
    updateConnection();
    baseStatus();
    autoGrow();
    els.levelFill.style.width = '2%';

    window.addEventListener('online', updateConnection);
    window.addEventListener('offline', updateConnection);
    window.addEventListener('resize', function () {
      autoGrow();
      scrollToBottom();
    });

    // API mínima para pruebas automatizadas.
    window.Susurro = {
      version: '1.0.0',
      settings: function () { return Object.assign({}, state.settings); },
      messages: function () {
        return Array.prototype.map.call(document.querySelectorAll('.msg'), function (el) {
          return {
            id: el.dataset.id,
            direction: el.dataset.direction,
            label: el.dataset.label || '',
            text: (el.querySelector('.msg-text') || {}).textContent || '',
            state: (el.querySelector('.msg-state') || {}).textContent || '',
            count: (el.querySelector('.msg-count') || {}).textContent || ''
          };
        });
      },
      send: function (text) {
        els.inputText.value = text == null ? '' : String(text);
        sendCurrentMessage();
      },
      incoming: function (text, preset) {
        return !!addIncoming(text, { label: 'mic', preset: preset || state.settings.preset });
      },
      transcribe: function (buffer, name) {
        var file = new File([buffer], name || 'audio.wav', { type: 'audio/wav' });
        return transcribeFile(file);
      }
    };
  }

  init();
})();
