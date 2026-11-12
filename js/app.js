/*
 * SoundBridge · mensajes que suenan.
 * Escribes un mensaje: aparece como texto y, justo después, como un audio que suena.
 * El otro teléfono, si está en rango, lo escucha con el micrófono y lo escribe solo
 * en el chat. Compartir o descargar el audio es opcional.
 */
(function () {
  'use strict';

  var PHY = window.PHY;
  if (!PHY) {
    console.error('No se cargó js/phy.js');
    return;
  }

  var DUPLICATE_WINDOW_MS = 15000;
  var MAX_INPUT_PX = 96;
  var ECHO_MARGIN_MS = 3000;

  // Parámetros fijos del audio generado (sin panel de ajustes).
  var EMIT_PRESET = 'normal';
  var EMIT_REPS = 2;
  var EMIT_VOLUME = 0.9;
  var RECEIVE_REPS = 2;
  var RECEIVE_VOLUME = 0.85;

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    chat: $('chat'),
    messages: $('messages'),
    emptyState: $('emptyState'),
    statusText: $('statusText'),
    statusDot: $('statusDot'),
    micLevel: $('micLevel'),
    levelFill: $('levelFill'),
    connectionText: $('connectionText'),
    connectionLabel: $('connectionLabel'),
    btnMic: $('btnMic'),
    composer: $('composer'),
    inputText: $('inputText'),
    btnSend: $('btnSend'),
    btnClip: $('btnClip'),
    fileInput: $('fileInput'),
    toasts: $('toasts')
  };

  var state = {
    seq: 0,
    entries: [],
    incoming: [],
    playing: null,
    lastEmitted: null,
    statusTimer: 0,
    transcribing: false,
    micMutedUntil: 0,
    micAutoRetry: false,
    micOptOut: false,
    micRetryArmed: false,
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
   * Iconos
   * ------------------------------------------------------------------ */

  var ICON_PLAY = '<svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor"></path></svg>';
  var ICON_PAUSE = '<svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor"></path></svg>';
  var ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  var ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  var ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>';

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

  function formatClock(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    var total = Math.round(seconds);
    var minutes = Math.floor(total / 60);
    var rest = total % 60;
    return minutes + ':' + String(rest).padStart(2, '0');
  }

  function setStatus(text, kind) {
    els.statusText.textContent = text;
    els.statusDot.className = 'status-dot' + (kind ? ' ' + kind : '');
  }

  function baseStatus() {
    if (state.mic.active) setStatus('Escuchando el aire · micrófono activo', 'listening');
    else if (state.mic.busy) setStatus('Activando micrófono…', 'syncing');
    else setStatus(state.micOptOut ? 'Micrófono silenciado · toca el icono para escuchar' : 'Listo · escribe un mensaje', '');
  }

  function scheduleStatusRevert(delay) {
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(function () {
      baseStatus();
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

  function slugFor(text) {
    var base = String(text).toLowerCase();
    if (base.normalize) base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    base = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    return 'soundbridge-' + (base || 'mensaje') + '-' + Date.now() + '.wav';
  }

  /* ------------------------------------------------------------------ *
   * Notas de audio
   * ------------------------------------------------------------------ */

  function createEmission(text, options) {
    options = options || {};
    var rendered = PHY.renderAudio(text, {
      preset: options.preset || EMIT_PRESET,
      reps: options.reps == null ? EMIT_REPS : options.reps,
      amplitude: options.amplitude == null ? EMIT_VOLUME : options.amplitude
    });
    var wav = PHY.encodeWav(rendered.samples, PHY.SR);
    var blob = new Blob([wav], { type: 'audio/wav' });
    var url = URL.createObjectURL(blob);
    return {
      text: rendered.text,
      samples: rendered.samples,
      duration: rendered.duration,
      preset: rendered.preset,
      reps: rendered.reps,
      blob: blob,
      url: url,
      fileName: slugFor(rendered.text)
    };
  }

  function buildWave(seedText) {
    var wave = document.createElement('div');
    wave.className = 'voice-wave';
    wave.setAttribute('aria-hidden', 'true');
    var seed = 2166136261;
    var i;
    for (i = 0; i < seedText.length; i++) {
      seed ^= seedText.charCodeAt(i);
      seed = Math.imul(seed, 16777619) >>> 0;
    }
    for (i = 0; i < 30; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      var bar = document.createElement('span');
      bar.style.height = (22 + (seed % 76)) + '%';
      wave.appendChild(bar);
    }
    return wave;
  }

  function ensureAudio(entry) {
    if (entry.audio) return entry.audio;
    var audio = new Audio(entry.url);
    audio.preload = 'auto';
    audio.addEventListener('ended', function () {
      if (state.playing && state.playing.entry === entry) {
        cancelAnimationFrame(state.playing.raf);
        state.playing = null;
      }
      unmuteMicAfterPlayback();
      updateVoiceUI(entry, false);
      setProgress(entry, 0);
      if (entry.direction === 'out') setEntryState(entry, 'audio listo');
    });
    audio.addEventListener('error', function () {
      toast('No se pudo reproducir este audio.', 'error');
    });
    entry.audio = audio;
    return audio;
  }

  function updateVoiceUI(entry, playing) {
    if (!entry.voiceEl) return;
    entry.voiceEl.classList.toggle('playing', playing);
    if (entry.toggleEl) {
      var label = playing ? 'Pausar audio' : 'Reproducir audio';
      entry.toggleEl.setAttribute('aria-label', label);
      entry.toggleEl.title = playing ? 'Pausar' : 'Reproducir';
    }
  }

  function setProgress(entry, pct) {
    if (!entry.trackEl) return;
    var value = Math.max(0, Math.min(100, pct));
    entry.trackEl.style.setProperty('--p', value.toFixed(2) + '%');
    entry.trackEl.setAttribute('aria-valuenow', String(Math.round(value)));
    if (entry.durationEl) entry.durationEl.textContent = formatClock(entry.duration);
  }

  function setEntryState(entry, text) {
    if (entry.stateEl) entry.stateEl.textContent = text;
  }

  function startProgress(entry) {
    function frame() {
      if (!state.playing || state.playing.entry !== entry) return;
      var audio = entry.audio;
      var duration = audio && isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : entry.duration;
      var pct = duration > 0 && audio ? (audio.currentTime / duration) * 100 : 0;
      setProgress(entry, pct);
      state.playing.raf = requestAnimationFrame(frame);
    }
    state.playing.raf = requestAnimationFrame(frame);
  }

  function stopPlayback(silent) {
    var playing = state.playing;
    if (!playing) return;
    var entry = playing.entry;
    state.playing = null;
    cancelAnimationFrame(playing.raf);
    if (entry.audio) {
      try { entry.audio.pause(); } catch (e) { /* nada */ }
    }
    unmuteMicAfterPlayback();
    updateVoiceUI(entry, false);
    if (!silent && entry.direction === 'out') {
      setEntryState(entry, entry.audio && entry.audio.currentTime > 0.05 ? 'en pausa' : 'audio listo');
    }
  }

  function muteMicForPlayback(entry) {
    state.micMutedUntil = Date.now() + (entry.duration + 0.6) * 1000;
    state.lastEmitted = {
      text: entry.text,
      until: Date.now() + entry.duration * 1000 + ECHO_MARGIN_MS
    };
    if (state.mic.decoder) {
      try { state.mic.decoder.reset(); } catch (e) { /* nada */ }
    }
  }

  function unmuteMicAfterPlayback() {
    state.micMutedUntil = Date.now() + 300;
    if (state.mic.decoder) {
      try { state.mic.decoder.reset(); } catch (e) { /* nada */ }
    }
  }

  function playEntry(entry) {
    if (!entry || !entry.url) return;
    stopPlayback(true);
    var audio = ensureAudio(entry);
    if (!audio.paused) {
      stopPlayback(false);
      return;
    }
    if (audio.ended || (isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.02)) {
      try { audio.currentTime = 0; } catch (e) { /* nada */ }
    }
    muteMicForPlayback(entry);
    state.playing = { entry: entry, raf: 0 };
    updateVoiceUI(entry, true);
    if (entry.direction === 'out') setEntryState(entry, 'reproduciendo…');
    startProgress(entry);

    var promise;
    try {
      promise = audio.play();
    } catch (e) {
      promise = null;
    }
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function () {
        if (state.playing && state.playing.entry === entry) {
          cancelAnimationFrame(state.playing.raf);
          state.playing = null;
        }
        updateVoiceUI(entry, false);
        if (entry.direction === 'out') setEntryState(entry, 'audio listo');
        toast('Toca ▶ para escuchar el audio.');
      });
    }
  }

  function buildVoice(entry) {
    var voice = document.createElement('div');
    voice.className = 'voice';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'voice-toggle';
    toggle.setAttribute('aria-label', 'Reproducir audio');
    toggle.title = 'Reproducir';
    toggle.innerHTML = ICON_PLAY + ICON_PAUSE;
    toggle.addEventListener('click', function () {
      var audio = ensureAudio(entry);
      if (!audio.paused) stopPlayback(false);
      else playEntry(entry);
    });
    voice.appendChild(toggle);

    var track = document.createElement('div');
    track.className = 'voice-track';
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', 'Progreso del audio');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', '0');
    track.setAttribute('tabindex', '0');
    track.style.setProperty('--p', '0%');
    track.appendChild(buildWave(entry.text));

    var overlay = document.createElement('div');
    overlay.className = 'voice-overlay';
    overlay.appendChild(buildWave(entry.text));
    track.appendChild(overlay);

    function seekFromEvent(event) {
      var rect = track.getBoundingClientRect();
      if (!rect.width) return;
      var pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      var audio = ensureAudio(entry);
      try { audio.currentTime = pct * entry.duration; } catch (e) { /* metadatos aún no listos */ }
      setProgress(entry, pct * 100);
    }

    track.addEventListener('click', seekFromEvent);
    track.addEventListener('keydown', function (event) {
      var audio = ensureAudio(entry);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        var step = event.key === 'ArrowRight' ? 2 : -2;
        try { audio.currentTime = Math.max(0, Math.min(entry.duration, audio.currentTime + step)); } catch (e) { /* nada */ }
        setProgress(entry, (audio.currentTime / entry.duration) * 100);
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (audio.paused) playEntry(entry);
        else stopPlayback(false);
      }
    });

    voice.appendChild(track);

    var duration = document.createElement('span');
    duration.className = 'voice-duration';
    duration.textContent = formatClock(entry.duration);
    voice.appendChild(duration);

    entry.voiceEl = voice;
    entry.toggleEl = toggle;
    entry.trackEl = track;
    entry.durationEl = duration;
    return voice;
  }

  function miniButton(icon, label, handler) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-mini';
    button.innerHTML = icon;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', handler);
    return button;
  }

  function downloadEntry(entry) {
    if (!entry.url) return;
    var link = document.createElement('a');
    link.href = entry.url;
    link.download = entry.fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast('Audio descargado. Compártelo con el otro teléfono.', 'ok');
  }

  function shareEntry(entry) {
    if (!entry.blob) {
      downloadEntry(entry);
      return;
    }
    var file = null;
    try {
      file = new File([entry.blob], entry.fileName, { type: 'audio/wav' });
    } catch (e) { /* sin File */ }

    if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({
        files: [file],
        title: 'SoundBridge',
        text: 'Audio de SoundBridge'
      }).catch(function () { /* compartir cancelado */ });
      return;
    }
    downloadEntry(entry);
  }

  function copyEntry(entry) {
    function done() {
      toast('Texto copiado', 'ok');
    }
    function fallback() {
      var area = document.createElement('textarea');
      area.value = entry.text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (ok) done();
      else toast('No se pudo copiar el texto.', 'error');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(entry.text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function buildActions(entry) {
    var actions = document.createElement('span');
    actions.className = 'msg-actions';
    actions.appendChild(miniButton(ICON_COPY, 'Copiar texto', function () { copyEntry(entry); }));
    
    var shareBtn = miniButton(ICON_SHARE, 'Compartir audio (opcional)', function () { shareEntry(entry); });
    var downloadBtn = miniButton(ICON_DOWNLOAD, 'Descargar audio (opcional)', function () { downloadEntry(entry); });
    
    var moreBtn = miniButton(
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="18" r="1.5" fill="currentColor"/></svg>',
      'Opciones de audio (opcional)',
      function () {
        if (shareBtn.parentElement) {
          shareBtn.remove();
          downloadBtn.remove();
        } else {
          actions.insertBefore(shareBtn, actions.firstChild);
          actions.insertBefore(downloadBtn, actions.firstChild);
        }
      }
    );
    actions.appendChild(moreBtn);
    return actions;
  }

  /* ------------------------------------------------------------------ *
   * Burbujas
   * ------------------------------------------------------------------ */

  function buildOutgoingText(text) {
    var id = ++state.seq;
    var article = document.createElement('article');
    article.className = 'msg';
    article.dataset.direction = 'out';
    article.dataset.id = 'm' + id;
    article.setAttribute('role', 'listitem');

    var entry = {
      id: 'm' + id,
      direction: 'out',
      text: text,
      time: Date.now(),
      label: 'texto',
      el: article
    };

    var p = document.createElement('p');
    p.className = 'msg-text';
    p.textContent = text;
    article.appendChild(p);

    var meta = document.createElement('div');
    meta.className = 'msg-meta';

    var time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(new Date(entry.time));
    meta.appendChild(time);

    var actions = document.createElement('span');
    actions.className = 'msg-actions';
    actions.appendChild(miniButton(ICON_COPY, 'Copiar texto', function () { copyEntry(entry); }));
    meta.appendChild(actions);

    article.appendChild(meta);
    els.messages.appendChild(article);

    state.entries.push(entry);
    hideEmptyState();
    scrollToBottom();
    return entry;
  }

  function buildOutgoingAudio(text, emission) {
    var id = ++state.seq;
    var article = document.createElement('article');
    article.className = 'msg';
    article.dataset.direction = 'out';
    article.dataset.id = 'm' + id;
    article.setAttribute('role', 'listitem');

    var entry = {
      id: 'm' + id,
      direction: 'out',
      text: text,
      time: Date.now(),
      label: 'audio',
      duration: emission.duration,
      preset: emission.preset,
      reps: emission.reps,
      samples: emission.samples,
      blob: emission.blob,
      url: emission.url,
      fileName: emission.fileName,
      el: article,
      audio: null
    };

    var label = document.createElement('span');
    label.className = 'msg-label';
    label.textContent = 'audio del mensaje';
    article.appendChild(label);

    article.appendChild(buildVoice(entry));

    var meta = document.createElement('div');
    meta.className = 'msg-meta';

    var stateEl = document.createElement('span');
    stateEl.className = 'msg-state';
    stateEl.textContent = 'reproduciendo…';
    meta.appendChild(stateEl);
    entry.stateEl = stateEl;

    var time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(new Date(entry.time));
    meta.appendChild(time);
    meta.appendChild(buildActions(entry));

    article.appendChild(meta);
    els.messages.appendChild(article);

    state.entries.push(entry);
    hideEmptyState();
    scrollToBottom();
    return entry;
  }

  function buildIncoming(text, options) {
    options = options || {};
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
      var preset = PHY.getPreset(options.preset || EMIT_PRESET);
      label.textContent = 'audio recibido · ' + preset.name;
    }
    article.appendChild(label);

    var p = document.createElement('p');
    p.className = 'msg-text';
    p.textContent = text;
    article.appendChild(p);

    var entry = {
      id: 'm' + id,
      direction: 'in',
      text: text,
      time: Date.now(),
      label: options.label === 'transcrito' ? 'transcrito' : 'mic',
      preset: options.preset || EMIT_PRESET,
      el: article,
      audio: null,
      duration: 0,
      blob: null,
      url: '',
      fileName: '',
      count: 1,
      countEl: null
    };

    // El audio recibido se puede escuchar y reenviar: se regenera a partir del texto.
    try {
      var emission = createEmission(text, {
        preset: entry.preset,
        reps: RECEIVE_REPS,
        amplitude: RECEIVE_VOLUME
      });
      entry.duration = emission.duration;
      entry.samples = emission.samples;
      entry.blob = emission.blob;
      entry.url = emission.url;
      entry.fileName = emission.fileName;
    } catch (e) {
      entry.duration = 0;
    }
    if (entry.url) article.appendChild(buildVoice(entry));

    var meta = document.createElement('div');
    meta.className = 'msg-meta';

    var count = document.createElement('span');
    count.className = 'msg-count';
    meta.appendChild(count);
    entry.countEl = count;

    var time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(new Date(entry.time));
    meta.appendChild(time);
    entry.timeEl = time;

    var received = document.createElement('span');
    received.className = 'msg-received';
    received.textContent = '✓✓';
    received.title = 'Recibido';
    meta.appendChild(received);

    meta.appendChild(buildActions(entry));
    article.appendChild(meta);
    els.messages.appendChild(article);

    state.entries.push(entry);
    state.incoming.push(entry);
    hideEmptyState();
    scrollToBottom();
    return entry;
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

  function addIncoming(text, options) {
    options = options || {};
    var clean = PHY.normalizeText(text);
    if (!clean) return null;
    if (options.label !== 'transcrito' &&
        state.lastEmitted &&
        state.lastEmitted.text === clean &&
        Date.now() < state.lastEmitted.until) {
      // Eco del propio altavoz capturado por el micrófono.
      return null;
    }

    var duplicate = findIncomingDuplicate(clean);
    if (duplicate) {
      duplicate.count++;
      duplicate.time = Date.now();
      duplicate.timeEl.textContent = formatTime(new Date(duplicate.time));
      if (duplicate.countEl) {
        duplicate.countEl.textContent = '×' + duplicate.count;
        duplicate.countEl.classList.add('show');
      }
      scrollToBottom();
      return duplicate;
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

    var emission;
    try {
      emission = createEmission(limited.text);
    } catch (e) {
      toast('No se pudo generar el audio del mensaje.', 'error');
      return;
    }

    // Primero el texto y, como mensaje aparte, el audio que suena.
    buildOutgoingText(limited.text);
    var audioEntry = buildOutgoingAudio(limited.text, emission);
    state.lastEmitted = {
      text: limited.text,
      until: Date.now() + emission.duration * 1000 + ECHO_MARGIN_MS
    };
    playEntry(audioEntry);

    // Para recibir respuestas sin tocar nada más, se enciende el micrófono
    // (este toque cuenta como gesto de usuario) salvo que lo hayas silenciado tú.
    if (!state.mic.active && !state.mic.busy && !state.micOptOut) startMic({ auto: true });
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

  els.inputText.addEventListener('input', autoGrow);

  /* ------------------------------------------------------------------ *
   * Micrófono opcional
   * ------------------------------------------------------------------ */

  var WORKLET_CODE = [
    'class SoundBridgeMic extends AudioWorkletProcessor {',
    '  process(inputs) {',
    '    const input = inputs[0];',
    '    const channel = input && input[0];',
    '    if (channel) this.port.postMessage(channel.slice(0));',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("soundbridge-mic", SoundBridgeMic);'
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

  function setMicUI(active, busy) {
    els.btnMic.classList.toggle('active', !!active);
    els.btnMic.setAttribute('aria-pressed', active ? 'true' : 'false');
    els.btnMic.disabled = !!busy;
    els.btnMic.setAttribute('aria-busy', busy ? 'true' : 'false');
    els.micLevel.classList.toggle('off', !active);
    if (active) els.btnMic.classList.remove('attention');
    var label = busy ? 'Conectando micrófono…' : (active ? 'Silenciar micrófono' : 'Activar micrófono');
    els.btnMic.setAttribute('aria-label', label);
    els.btnMic.title = busy ? 'Conectando…' : (active ? 'Micrófono activo · toca para silenciar' : 'Micrófono · toca para activar');
  }

  function pushMicSamples(data, rate) {
    var mic = state.mic;
    if (!mic.active || !mic.decoder) return;
    // Mientras este teléfono reproduce su propio audio, no se escucha a sí mismo.
    if (Date.now() < state.micMutedUntil) return;
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
    setStatus('Mensaje recibido · texto listo', 'received');
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
      return new AudioWorkletNode(ctx, 'soundbridge-mic', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
    }, function (err) {
      URL.revokeObjectURL(url);
      throw err;
    });
  }

  // Si el navegador deja el micrófono suspendido hasta que haya un toque, se reanuda con el primero.
  function resumeOnGesture(ctx) {
    if (!ctx || ctx.state !== 'suspended') return;
    var handler = function () {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
  }

  // Si el arranque automático falla (permiso o política del navegador), se reintenta con el primer toque.
  function armMicRetry() {
    if (state.micRetryArmed) return;
    state.micRetryArmed = true;
    var handler = function () {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
      state.micRetryArmed = false;
      if (!state.mic.active && !state.mic.busy && !state.micOptOut) startMic();
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
  }

  async function startMic(options) {
    options = options || {};
    var auto = options.auto === true;
    if (state.mic.active || state.mic.busy) return;
    if (!isSecureForMic()) {
      setStatus('El micrófono requiere HTTPS o localhost', 'error');
      if (!auto) toast('El micrófono requiere HTTPS o localhost.', 'error');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Micrófono no disponible', 'error');
      if (!auto) toast('Este navegador no permite usar el micrófono.', 'error');
      return;
    }

    state.mic.busy = true;
    setMicUI(false, true);
    setStatus('Activando micrófono…', 'syncing');

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
      if (ctx.state === 'suspended') {
        // Sin gesto de usuario puede quedar suspendido; se reanuda al primer toque.
        ctx.resume().catch(function () {});
        resumeOnGesture(ctx);
      }

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

      setMicUI(true, false);
      setStatus('Micrófono activo · escuchando', 'listening');
      if (!auto) toast('Micrófono activo. Recibirás los mensajes cercanos automáticamente.', 'ok');
    } catch (error) {
      if (stream) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* nada */ }
      }
      state.mic.busy = false;
      setMicUI(false, false);
      var message = micErrorMessage(error);
      setStatus(message, 'error');
      toast(message, 'error');
      if (auto) armMicRetry();
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
    setMicUI(false, false);
    baseStatus();
  }

  els.btnMic.addEventListener('click', function () {
    if (state.mic.busy) return;
    if (state.mic.active) {
      state.micOptOut = true; // silenciado a propósito: no se reactiva solo
      stopMic();
    } else {
      state.micOptOut = false;
      startMic();
    }
  });

  /* ------------------------------------------------------------------ *
   * Transcripción de archivos (sin micrófono)
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
        toast('El audio no contiene ningún mensaje de SoundBridge.', 'error');
        setStatus(micWasActive ? 'Micrófono activo · escuchando' : 'Listo · escribe un mensaje',
          micWasActive ? 'listening' : '');
        return;
      }

      var added = 0;
      for (var i = 0; i < results.length; i++) {
        if (addIncoming(results[i].text, { label: 'transcrito', preset: results[i].preset })) added++;
      }
      if (added === 0) {
        toast('El audio solo contenía ecos del propio dispositivo.', 'error');
      } else {
        toast(added === 1 ? 'Audio transcrito · texto listo' : added + ' mensajes transcritos', 'ok');
      }
      setStatus('Audio transcrito · texto listo', 'received');
      scheduleStatusRevert();
    } catch (error) {
      var message = 'No se pudo leer el archivo de audio.';
      if (error && (error.name === 'EncodingError' || error.message === 'sin-offline')) {
        message = 'Formato de audio no compatible.';
      }
      toast(message, 'error');
      setStatus(micWasActive ? 'Micrófono activo · escuchando' : 'Listo · escribe un mensaje',
        micWasActive ? 'listening' : '');
    } finally {
      state.transcribing = false;
      els.fileInput.value = '';
    }
  }

  function isAudioFile(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('audio/') === 0) return true;
    return /\.(wav|mp3|m4a|ogg|webm)$/i.test(file.name || '');
  }

  els.btnClip.addEventListener('click', function () {
    els.fileInput.click();
  });

  els.fileInput.addEventListener('change', function () {
    var file = els.fileInput.files && els.fileInput.files[0];
    if (file) transcribeFile(file);
  });

  // Arrastrar y soltar un audio sobre la conversación.
  ['dragenter', 'dragover'].forEach(function (name) {
    els.chat.addEventListener(name, function (event) {
      event.preventDefault();
      els.chat.classList.add('dragover');
    });
  });
  ['dragleave', 'dragend'].forEach(function (name) {
    els.chat.addEventListener(name, function (event) {
      if (event.target === els.chat || !els.chat.contains(event.relatedTarget)) {
        els.chat.classList.remove('dragover');
      }
    });
  });
  els.chat.addEventListener('drop', function (event) {
    event.preventDefault();
    els.chat.classList.remove('dragover');
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    if (isAudioFile(file)) transcribeFile(file);
    else toast('Selecciona un archivo de audio.', 'error');
  });

  /* ------------------------------------------------------------------ *
   * Arranque
   * ------------------------------------------------------------------ */

  function init() {
    setMicUI(false, false);
    baseStatus();
    updateConnection();
    autoGrow();
    els.levelFill.style.width = '2%';

    // Escucha desde el primer momento: no hace falta enviar ni abrir ningún archivo.
    startMic({ auto: true });

    window.addEventListener('online', updateConnection);
    window.addEventListener('offline', updateConnection);
    window.addEventListener('resize', function () {
      autoGrow();
      scrollToBottom();
    });

    // API mínima para pruebas automatizadas.
    window.SoundBridge = {
      version: '2.0.0',
      messages: function () {
        return state.entries.map(function (entry) {
          return {
            id: entry.id,
            direction: entry.direction,
            label: entry.label || '',
            text: entry.text,
            state: entry.stateEl ? entry.stateEl.textContent : '',
            count: entry.countEl ? entry.countEl.textContent : '',
            hasAudio: !!entry.url,
            duration: entry.duration,
            playing: !!(entry.audio && !entry.audio.paused)
          };
        });
      },
      send: function (text) {
        els.inputText.value = text == null ? '' : String(text);
        sendCurrentMessage();
      },
      incoming: function (text, preset) {
        return !!addIncoming(text, { label: 'mic', preset: preset || EMIT_PRESET });
      },
      transcribe: function (buffer, name) {
        var file = new File([buffer], name || 'audio.wav', { type: 'audio/wav' });
        return transcribeFile(file);
      },
      play: function (id) {
        for (var i = 0; i < state.entries.length; i++) {
          if (state.entries[i].id === id) {
            playEntry(state.entries[i]);
            return true;
          }
        }
        return false;
      },
      stop: function () { stopPlayback(false); }
    };
  }

  init();
})();
