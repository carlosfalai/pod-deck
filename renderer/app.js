/* ============================================================
   PodDeck — Virtual RODECaster
   Full soundboard + mixer logic
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────
const state = {
  currentBank: 'A',
  // pads[bank][index] = { label, filePath, icon, color, mode, volume }
  pads: { A: {}, B: {}, C: {}, D: {} },
  channels: [
    { id: 'mic1',    name: 'MIC 1',      color: '#EAB308', volume: 80, muted: false, phantom: true,  comp: true,  deess: true,  gate: true,  eq: 'Natural' },
    { id: 'mic2',    name: 'MIC 2',      color: '#3b82f6', volume: 80, muted: false, phantom: false, comp: false, deess: false, gate: false, eq: 'Natural' },
    { id: 'usb',     name: 'USB AUDIO',  color: '#22c55e', volume: 70, muted: false, phantom: false, comp: false, deess: false, gate: false, eq: 'Warm' },
    { id: 'sfx',     name: 'SOUND PADS', color: '#a855f7', volume: 75, muted: false, phantom: false, comp: false, deess: false, gate: false, eq: 'Natural' },
    { id: 'phone',   name: 'PHONE / BT', color: '#f97316', volume: 65, muted: false, phantom: false, comp: true,  deess: false, gate: true,  eq: 'Bright' }
  ],
  master: { volume: 85 },
  recording: { active: false, paused: false, startTime: null, elapsed: 0, format: 'WAV' },
  tracks: [
    { name: 'MIC 1',      color: '#EAB308', armed: true  },
    { name: 'MIC 2',      color: '#3b82f6', armed: false },
    { name: 'USB AUDIO',  color: '#22c55e', armed: false },
    { name: 'SOUND PADS', color: '#a855f7', armed: true  },
    { name: 'MASTER MIX', color: '#ef4444', armed: true  }
  ],
  activePads: new Map(),  // padKey -> { audio, animFrame }
  contextTarget: null,    // { bank, index }
  editTarget: null,
  vuIntervals: [],
  recInterval: null
};

const EQ_PRESETS = ['Natural', 'Warm', 'Bright', 'Custom'];
const PAD_COLORS = ['#EAB308','#ef4444','#22c55e','#3b82f6','#a855f7','#f97316','#ec4899','#06b6d4','#666666'];
const DEFAULT_ICONS = ['🎵','🎶','🎤','🎸','🥁','🎺','🔔','🚨','📢','💥','🎭','🌟','👏','😂','⚡','🎬'];
const DEFAULT_LABELS = [
  'Intro Music','Outro Music','Applause','Laugh Track',
  'Sting 1','Sting 2','Alert','Transition',
  'Sound 9','Sound 10','Sound 11','Sound 12',
  'Sound 13','Sound 14','Sound 15','Sound 16'
];

// ── SANITIZATION HELPERS ──────────────────────────────────
function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Safe Object.assign that blocks prototype-poisoning keys
function safeAssign(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    target[key] = source[key];
  }
}

// ── AUDIO CONTEXT ─────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Audio buffers cache
const audioBuffers = new Map();

async function loadAudioBuffer(filePath) {
  if (audioBuffers.has(filePath)) return audioBuffers.get(filePath);
  try {
    const response = await fetch(`file:///${filePath.replace(/\\/g, '/')}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const ctx = getAudioCtx();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    audioBuffers.set(filePath, audioBuffer);
    return audioBuffer;
  } catch (err) {
    console.error('Failed to load audio:', filePath, err);
    return null;
  }
}

// ── INIT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadPersistedState();
  buildPadGrid();
  buildChannelStrips();
  buildTrackList();
  bindBankButtons();
  bindRecordingControls();
  bindFormatButtons();
  bindContextMenu();
  bindModalEvents();
  bindColorPicker();
  bindBtToggle();
  startVuMeters();
  initAudioStatus();
});

// ── PERSIST ───────────────────────────────────────────────
async function loadPersistedState() {
  if (!window.podAPI) return;
  try {
    const savedPads = await window.podAPI.get('pads', null);
    if (savedPads && typeof savedPads === 'object') {
      for (const bank of ['A', 'B', 'C', 'D']) {
        if (savedPads[bank] && typeof savedPads[bank] === 'object') {
          safeAssign(state.pads[bank], savedPads[bank]);
        }
      }
    }
    const savedChannels = await window.podAPI.get('channels', null);
    if (Array.isArray(savedChannels)) {
      savedChannels.forEach((sc, i) => {
        if (state.channels[i] && sc && typeof sc === 'object') {
          safeAssign(state.channels[i], sc);
        }
      });
    }
    const savedMaster = await window.podAPI.get('master', null);
    if (savedMaster && typeof savedMaster === 'object') safeAssign(state.master, savedMaster);
    const savedFormat = await window.podAPI.get('recFormat', 'WAV');
    if (savedFormat === 'WAV' || savedFormat === 'MP3') {
      state.recording.format = savedFormat;
    }
  } catch (err) {
    console.error('Failed to load persisted state:', err);
  }
}

async function persistPads() {
  if (window.podAPI) await window.podAPI.set('pads', state.pads);
}

async function persistChannels() {
  if (window.podAPI) await window.podAPI.set('channels', state.channels);
}

// ── PAD GRID ──────────────────────────────────────────────
function buildPadGrid() {
  const grid = document.getElementById('pad-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const pad = createPadEl(state.currentBank, i);
    grid.appendChild(pad);
  }
  updatePadsLoaded();
}

// Validate a CSS hex color value
function isValidHexColor(str) {
  return typeof str === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(str);
}

function createPadEl(bank, index) {
  const padData = state.pads[bank][index] || {};
  const div = document.createElement('div');
  div.className = 'sound-pad' + (padData.filePath ? ' has-sound' : '');
  div.dataset.index = index;
  div.dataset.bank = bank;

  const color = isValidHexColor(padData.color) ? padData.color : '#333333';
  const icon = padData.icon || DEFAULT_ICONS[index] || '🎵';
  const label = padData.label || DEFAULT_LABELS[index] || `Pad ${index + 1}`;
  const modeBadge = padData.mode ? padData.mode.toUpperCase().slice(0, 1) : 'S';

  // Build DOM safely to avoid XSS
  const padBg = document.createElement('div');
  padBg.className = 'pad-bg';
  padBg.style.background = color;

  const padNum = document.createElement('div');
  padNum.className = 'pad-number';
  padNum.textContent = String(index + 1);

  const padIcon = document.createElement('div');
  padIcon.className = 'pad-icon';
  padIcon.textContent = icon;

  const padLabel = document.createElement('div');
  padLabel.className = 'pad-label' + (padData.filePath ? ' has-sound' : '');
  padLabel.textContent = label;

  const padMode = document.createElement('div');
  padMode.className = 'pad-mode-badge';
  padMode.textContent = modeBadge;

  const padProgress = document.createElement('div');
  padProgress.className = 'pad-progress';
  padProgress.id = `progress-${bank}-${index}`;

  div.appendChild(padBg);
  div.appendChild(padNum);
  div.appendChild(padIcon);
  div.appendChild(padLabel);
  div.appendChild(padMode);
  div.appendChild(padProgress);

  if (isValidHexColor(padData.color)) {
    div.style.borderColor = padData.color + '66';
  }

  // Left click: play
  div.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerPad(bank, index);
  });

  // Right click: context menu
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, bank, index);
  });

  return div;
}

function refreshPadEl(bank, index) {
  const grid = document.getElementById('pad-grid');
  const old = grid.querySelector(`[data-index="${index}"]`);
  if (!old) return;
  const newEl = createPadEl(bank, index);
  grid.replaceChild(newEl, old);
}

// ── PAD TRIGGER ───────────────────────────────────────────
async function triggerPad(bank, index) {
  const padKey = `${bank}-${index}`;
  const padData = state.pads[bank][index];
  if (!padData || !padData.filePath) {
    // Flash empty pad
    const el = document.querySelector(`[data-index="${index}"][data-bank="${bank}"]`);
    if (el) {
      el.style.borderColor = '#444';
      setTimeout(() => { el.style.borderColor = ''; }, 200);
    }
    return;
  }

  const mode = padData.mode || 'oneshot';
  const sfxChannel = state.channels.find(c => c.id === 'sfx');
  const volume = ((padData.volume || 100) / 100) * ((sfxChannel ? sfxChannel.volume : 100) / 100) * (state.master.volume / 100);

  // Toggle: if playing, stop it
  if ((mode === 'toggle' || mode === 'loop') && state.activePads.has(padKey)) {
    stopPad(padKey);
    return;
  }

  const ctx = getAudioCtx();
  const buffer = await loadAudioBuffer(padData.filePath);
  if (!buffer) return;

  const gainNode = ctx.createGain();
  gainNode.gain.value = volume;
  gainNode.connect(ctx.destination);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = (mode === 'loop');
  source.connect(gainNode);
  source.start(0);

  // Visual feedback
  const padEl = document.querySelector(`[data-index="${index}"][data-bank="${bank}"]`);
  if (padEl) padEl.classList.add('playing');

  // Progress animation
  if (mode !== 'loop' && buffer.duration > 0) {
    const startTime = ctx.currentTime;
    const duration = buffer.duration;
    const progressEl = document.getElementById(`progress-${bank}-${index}`);

    let rafId;
    const animate = () => {
      const pct = Math.min(((ctx.currentTime - startTime) / duration) * 100, 100);
      if (progressEl) progressEl.style.width = pct + '%';
      if (pct < 100) {
        rafId = requestAnimationFrame(animate);
      } else {
        if (progressEl) progressEl.style.width = '0%';
      }
    };
    rafId = requestAnimationFrame(animate);
    state.activePads.set(padKey, { source, gainNode, rafId });
  } else {
    state.activePads.set(padKey, { source, gainNode, rafId: null });
  }

  source.onended = () => {
    stopPad(padKey, true);
  };
}

function stopPad(padKey, fromEnded = false) {
  const entry = state.activePads.get(padKey);
  if (!entry) return;

  if (!fromEnded) {
    try { entry.source.stop(); } catch (e) { /* already stopped */ }
  }
  if (entry.rafId) cancelAnimationFrame(entry.rafId);
  state.activePads.delete(padKey);

  const [bank, index] = padKey.split('-');
  const padEl = document.querySelector(`[data-index="${index}"][data-bank="${bank}"]`);
  if (padEl) {
    padEl.classList.remove('playing');
    const progressEl = document.getElementById(`progress-${bank}-${index}`);
    if (progressEl) progressEl.style.width = '0%';
  }
}

// ── BANK SWITCHING ────────────────────────────────────────
function bindBankButtons() {
  document.querySelectorAll('.bank-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const bank = btn.dataset.bank;
      state.currentBank = bank;
      document.querySelectorAll('.bank-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('bank-label').textContent = 'BANK ' + bank;
      document.getElementById('footer-bank').textContent = bank;
      buildPadGrid();
    });
  });
}

// ── CHANNEL STRIPS ────────────────────────────────────────
function buildChannelStrips() {
  const wrap = document.getElementById('channels-wrap');
  wrap.innerHTML = '';
  state.channels.forEach((ch, i) => {
    wrap.appendChild(createChannelStrip(ch, i));
  });
  // Master strip
  wrap.appendChild(createMasterStrip());
}

function createChannelStrip(ch, idx) {
  const div = document.createElement('div');
  div.className = 'channel-strip' + (ch.muted ? ' muted' : '');
  div.id = `channel-${escHtml(ch.id)}`;

  const safeColor = isValidHexColor(ch.color) ? ch.color : '#EAB308';
  const safeVolume = Math.max(0, Math.min(100, parseInt(ch.volume) || 0));
  const safeIdx = String(idx);

  // Channel name
  const nameEl = document.createElement('div');
  nameEl.className = 'channel-name';
  nameEl.style.color = safeColor;
  nameEl.textContent = ch.name;
  div.appendChild(nameEl);

  // VU Meter
  const vuMeter = document.createElement('div');
  vuMeter.className = 'vu-meter';
  const vuFill = document.createElement('div');
  vuFill.className = 'vu-fill';
  vuFill.id = `vu-${ch.id}`;
  vuFill.style.width = '0%';
  vuMeter.appendChild(vuFill);
  div.appendChild(vuMeter);

  // Processing section
  const procSection = document.createElement('div');
  procSection.className = 'processing-section';

  const procs = [
    { key: 'comp',  label: 'COMP', tip: 'Compressor' },
    { key: 'deess', label: 'DE-S', tip: 'De-esser' },
    { key: 'gate',  label: 'GATE', tip: 'Noise Gate' }
  ];
  procs.forEach(({ key, label, tip }) => {
    const toggle = document.createElement('div');
    toggle.className = 'proc-toggle' + (ch[key] ? ' on' : '');
    toggle.dataset.proc = key;
    toggle.dataset.ch = safeIdx;
    toggle.dataset.tip = tip;
    const procLabel = document.createElement('span');
    procLabel.className = 'proc-label';
    procLabel.textContent = label;
    const procLed = document.createElement('div');
    procLed.className = 'proc-led';
    toggle.appendChild(procLabel);
    toggle.appendChild(procLed);
    procSection.appendChild(toggle);
  });

  // EQ select — uses only known preset values, safe
  const eqSel = document.createElement('select');
  eqSel.className = 'eq-select';
  eqSel.dataset.ch = safeIdx;
  eqSel.id = `eq-${ch.id}`;
  EQ_PRESETS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    opt.selected = ch.eq === p;
    eqSel.appendChild(opt);
  });
  procSection.appendChild(eqSel);
  div.appendChild(procSection);

  // Fader
  const faderWrap = document.createElement('div');
  faderWrap.className = 'fader-wrap';
  const faderInput = document.createElement('input');
  faderInput.type = 'range';
  faderInput.className = 'channel-fader';
  faderInput.min = '0';
  faderInput.max = '100';
  faderInput.value = String(safeVolume);
  faderInput.id = `fader-${ch.id}`;
  faderInput.dataset.ch = safeIdx;
  const faderVal = document.createElement('div');
  faderVal.className = 'fader-value';
  faderVal.id = `fval-${ch.id}`;
  faderVal.textContent = String(safeVolume);
  faderWrap.appendChild(faderInput);
  faderWrap.appendChild(faderVal);
  div.appendChild(faderWrap);

  // Mute button
  const muteBtn = document.createElement('button');
  muteBtn.className = 'mute-btn' + (ch.muted ? ' muted' : '');
  muteBtn.dataset.ch = safeIdx;
  muteBtn.id = `mute-${ch.id}`;
  muteBtn.textContent = ch.muted ? 'UNMUTE' : 'MUTE';
  div.appendChild(muteBtn);

  // Phantom power (mic channels only)
  if (ch.id === 'mic1' || ch.id === 'mic2') {
    const phantomBtn = document.createElement('button');
    phantomBtn.className = 'phantom-btn' + (ch.phantom ? ' on' : '');
    phantomBtn.dataset.ch = safeIdx;
    phantomBtn.id = `phantom-${ch.id}`;
    phantomBtn.dataset.tip = '+48V Phantom Power';
    phantomBtn.textContent = '48V';
    div.appendChild(phantomBtn);
  }

  // Bind proc toggles
  div.querySelectorAll('.proc-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const ci = parseInt(toggle.dataset.ch);
      const proc = toggle.dataset.proc;
      state.channels[ci][proc] = !state.channels[ci][proc];
      toggle.classList.toggle('on', state.channels[ci][proc]);
      persistChannels();
    });
  });

  // Bind EQ
  const eqSel = div.querySelector('.eq-select');
  if (eqSel) {
    eqSel.addEventListener('change', () => {
      state.channels[idx].eq = eqSel.value;
      persistChannels();
    });
  }

  // Bind fader
  const fader = div.querySelector('.channel-fader');
  if (fader) {
    fader.addEventListener('input', () => {
      const ci = parseInt(fader.dataset.ch);
      state.channels[ci].volume = parseInt(fader.value);
      const fval = document.getElementById(`fval-${ch.id}`);
      if (fval) fval.textContent = fader.value;
      persistChannels();
    });
  }

  // Bind mute
  const muteBtn = div.querySelector('.mute-btn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      const ci = parseInt(muteBtn.dataset.ch);
      state.channels[ci].muted = !state.channels[ci].muted;
      muteBtn.classList.toggle('muted', state.channels[ci].muted);
      muteBtn.textContent = state.channels[ci].muted ? 'UNMUTE' : 'MUTE';
      div.classList.toggle('muted', state.channels[ci].muted);
      persistChannels();
    });
  }

  // Bind phantom
  const phantomBtn = div.querySelector('.phantom-btn');
  if (phantomBtn) {
    phantomBtn.addEventListener('click', () => {
      const ci = parseInt(phantomBtn.dataset.ch);
      state.channels[ci].phantom = !state.channels[ci].phantom;
      phantomBtn.classList.toggle('on', state.channels[ci].phantom);
      persistChannels();
    });
  }

  return div;
}

function createMasterStrip() {
  const div = document.createElement('div');
  div.className = 'master-strip';
  div.id = 'master-strip';

  const safeVol = Math.max(0, Math.min(100, parseInt(state.master.volume) || 85));

  const label = document.createElement('div');
  label.className = 'master-label';
  label.textContent = 'MASTER';
  div.appendChild(label);

  const masterVu = document.createElement('div');
  masterVu.className = 'master-vu';
  ['vu-master-l', 'vu-master-r'].forEach(id => {
    const meter = document.createElement('div');
    meter.className = 'vu-meter';
    const fill = document.createElement('div');
    fill.className = 'vu-fill';
    fill.id = id;
    fill.style.width = '0%';
    meter.appendChild(fill);
    masterVu.appendChild(meter);
  });
  div.appendChild(masterVu);

  const faderWrap = document.createElement('div');
  faderWrap.className = 'fader-wrap';
  faderWrap.style.minHeight = '100px';
  const fader = document.createElement('input');
  fader.type = 'range';
  fader.className = 'channel-fader';
  fader.min = '0';
  fader.max = '100';
  fader.value = String(safeVol);
  fader.id = 'fader-master';
  const fval = document.createElement('div');
  fval.className = 'fader-value';
  fval.id = 'fval-master';
  fval.textContent = String(safeVol);
  faderWrap.appendChild(fader);
  faderWrap.appendChild(fval);
  div.appendChild(faderWrap);

  const outLabel = document.createElement('div');
  outLabel.style.cssText = 'font-size:9px; color:var(--text-muted); text-align:center; letter-spacing:1px;';
  outLabel.textContent = 'OUT';
  div.appendChild(outLabel);

  fader.addEventListener('input', () => {
    state.master.volume = parseInt(fader.value);
    const fvalEl = document.getElementById('fval-master');
    if (fvalEl) fvalEl.textContent = fader.value;
    if (window.podAPI) window.podAPI.set('master', state.master);
  });

  return div;
}

// ── VU METERS (simulated) ─────────────────────────────────
function startVuMeters() {
  // Simulate VU movement for visual feedback
  state.vuIntervals.push(setInterval(() => {
    state.channels.forEach(ch => {
      if (ch.muted) {
        setVu(`vu-${ch.id}`, 0);
        return;
      }
      // Simulate low-level noise floor + occasional signal
      const base = ch.volume > 0 ? (Math.random() * 15 + (ch.volume * 0.1)) : 0;
      const signal = Math.random() < 0.1 ? Math.random() * 60 : 0;
      const level = Math.min(base + signal, 100);
      setVu(`vu-${ch.id}`, level);
    });
    // Master VU
    const masterLevel = Math.random() * 20 + (state.master.volume * 0.15);
    setVu('vu-master-l', Math.min(masterLevel + (Math.random() * 10 - 5), 100));
    setVu('vu-master-r', Math.min(masterLevel + (Math.random() * 10 - 5), 100));
  }, 100));
}

function setVu(id, percent) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.max(0, percent) + '%';
}

// ── RECORDING ─────────────────────────────────────────────
function bindRecordingControls() {
  document.getElementById('btn-record').addEventListener('click', toggleRecord);
  document.getElementById('btn-pause').addEventListener('click', togglePause);
  document.getElementById('btn-stop').addEventListener('click', stopRecording);
}

function toggleRecord() {
  if (state.recording.active && !state.recording.paused) return; // already recording
  if (state.recording.paused) {
    // Resume
    state.recording.paused = false;
    state.recording.startTime = Date.now() - (state.recording.elapsed * 1000);
    startRecTimer();
    updateRecUI();
    return;
  }
  // Start new recording
  state.recording.active = true;
  state.recording.paused = false;
  state.recording.startTime = Date.now();
  state.recording.elapsed = 0;
  startRecTimer();
  updateRecUI();
}

function togglePause() {
  if (!state.recording.active) return;
  state.recording.paused = !state.recording.paused;
  if (state.recording.paused) {
    state.recording.elapsed = (Date.now() - state.recording.startTime) / 1000;
    clearInterval(state.recInterval);
    state.recInterval = null;
  } else {
    state.recording.startTime = Date.now() - (state.recording.elapsed * 1000);
    startRecTimer();
  }
  updateRecUI();
}

function stopRecording() {
  if (!state.recording.active) return;
  clearInterval(state.recInterval);
  state.recInterval = null;
  state.recording.active = false;
  state.recording.paused = false;
  state.recording.elapsed = 0;
  document.getElementById('rec-timer').textContent = '00:00:00';
  updateRecUI();
}

function startRecTimer() {
  clearInterval(state.recInterval);
  state.recInterval = setInterval(() => {
    const elapsed = (Date.now() - state.recording.startTime) / 1000;
    document.getElementById('rec-timer').textContent = formatTime(elapsed);
  }, 500);
}

function updateRecUI() {
  const recBtn = document.getElementById('btn-record');
  const pauseBtn = document.getElementById('btn-pause');
  const timer = document.getElementById('rec-timer');
  const dot = document.getElementById('rec-dot');
  const text = document.getElementById('rec-status-text');

  if (state.recording.active && !state.recording.paused) {
    recBtn.classList.add('active');
    timer.classList.add('recording');
    dot.className = 'status-dot recording';
    text.textContent = 'Recording';
  } else if (state.recording.paused) {
    recBtn.classList.remove('active');
    timer.classList.remove('recording');
    dot.className = 'status-dot active';
    text.textContent = 'Paused';
  } else {
    recBtn.classList.remove('active');
    timer.classList.remove('recording');
    dot.className = 'status-dot';
    text.textContent = 'Stopped';
  }
}

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// ── FORMAT BUTTONS ────────────────────────────────────────
function bindFormatButtons() {
  document.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.recording.format = btn.dataset.fmt;
      if (window.podAPI) window.podAPI.set('recFormat', state.recording.format);
    });
  });
  // Set initial
  document.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fmt === state.recording.format);
  });
}

// ── TRACK LIST ────────────────────────────────────────────
function buildTrackList() {
  const list = document.getElementById('track-list');
  if (!list) return;
  list.innerHTML = '';
  state.tracks.forEach((track, i) => {
    const row = document.createElement('div');
    row.className = 'track-row';

    const dot = document.createElement('div');
    dot.className = 'track-dot';
    dot.style.background = isValidHexColor(track.color) ? track.color : '#888888';

    const name = document.createElement('div');
    name.className = 'track-name';
    name.textContent = track.name;

    const arm = document.createElement('div');
    arm.className = 'track-arm' + (track.armed ? ' armed' : '');
    arm.dataset.track = String(i);
    arm.title = 'Arm track';
    arm.textContent = track.armed ? 'R' : '·';

    arm.addEventListener('click', (e) => {
      const ti = parseInt(e.target.dataset.track);
      if (isNaN(ti) || ti < 0 || ti >= state.tracks.length) return;
      state.tracks[ti].armed = !state.tracks[ti].armed;
      e.target.classList.toggle('armed', state.tracks[ti].armed);
      e.target.textContent = state.tracks[ti].armed ? 'R' : '·';
    });

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(arm);
    list.appendChild(row);
  });
}

// ── CONTEXT MENU ──────────────────────────────────────────
function bindContextMenu() {
  const menu = document.getElementById('context-menu');

  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('contextmenu', () => hideContextMenu());

  document.getElementById('ctx-assign').addEventListener('click', async () => {
    hideContextMenu();
    if (!state.contextTarget) return;
    const { bank, index } = state.contextTarget;
    if (!window.podAPI) return;
    const filePath = await window.podAPI.openAudioFile();
    if (!filePath) return;
    if (!state.pads[bank][index]) state.pads[bank][index] = {};
    state.pads[bank][index].filePath = filePath;
    if (!state.pads[bank][index].label || state.pads[bank][index].label === DEFAULT_LABELS[index]) {
      // Auto-set label from filename
      const fname = filePath.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
      state.pads[bank][index].label = fname.slice(0, 20);
    }
    await persistPads();
    refreshPadEl(bank, index);
    updatePadsLoaded();
  });

  document.getElementById('ctx-edit').addEventListener('click', () => {
    hideContextMenu();
    if (!state.contextTarget) return;
    openEditModal(state.contextTarget.bank, state.contextTarget.index);
  });

  document.getElementById('ctx-clear').addEventListener('click', async () => {
    hideContextMenu();
    if (!state.contextTarget) return;
    const { bank, index } = state.contextTarget;
    state.pads[bank][index] = {};
    await persistPads();
    refreshPadEl(bank, index);
    updatePadsLoaded();
  });
}

function showContextMenu(x, y, bank, index) {
  state.contextTarget = { bank, index };
  const menu = document.getElementById('context-menu');
  menu.style.display = 'block';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  // Keep menu in viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;
  });
}

function hideContextMenu() {
  document.getElementById('context-menu').style.display = 'none';
}

// ── COLOR PICKER ──────────────────────────────────────────
function bindColorPicker() {
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', async () => {
      if (!state.contextTarget) return;
      const { bank, index } = state.contextTarget;
      if (!state.pads[bank][index]) state.pads[bank][index] = {};
      state.pads[bank][index].color = swatch.dataset.color;
      await persistPads();
      if (bank === state.currentBank) refreshPadEl(bank, index);
    });
  });
}

// ── EDIT MODAL ────────────────────────────────────────────
function openEditModal(bank, index) {
  state.editTarget = { bank, index };
  const padData = state.pads[bank][index] || {};

  document.getElementById('modal-label').value = padData.label || DEFAULT_LABELS[index] || '';
  document.getElementById('modal-filepath').textContent = padData.filePath || 'No file assigned';
  document.getElementById('modal-icon').value = padData.icon || DEFAULT_ICONS[index] || '🎵';
  document.getElementById('modal-mode').value = padData.mode || 'oneshot';
  const vol = padData.volume !== undefined ? padData.volume : 100;
  document.getElementById('modal-volume').value = vol;
  document.getElementById('modal-vol-display').textContent = vol;

  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('modal-label').focus();
}

function bindModalEvents() {
  document.getElementById('modal-volume').addEventListener('input', (e) => {
    document.getElementById('modal-vol-display').textContent = e.target.value;
  });

  document.getElementById('modal-browse').addEventListener('click', async () => {
    if (!window.podAPI) return;
    const filePath = await window.podAPI.openAudioFile();
    if (filePath) {
      document.getElementById('modal-filepath').textContent = filePath;
    }
  });

  document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-overlay').style.display = 'none';
  });

  document.getElementById('modal-save').addEventListener('click', async () => {
    if (!state.editTarget) return;
    const { bank, index } = state.editTarget;
    const fileText = document.getElementById('modal-filepath').textContent;

    if (!state.pads[bank][index]) state.pads[bank][index] = {};
    state.pads[bank][index].label = document.getElementById('modal-label').value.trim() || DEFAULT_LABELS[index];
    state.pads[bank][index].icon = document.getElementById('modal-icon').value || DEFAULT_ICONS[index];
    state.pads[bank][index].mode = document.getElementById('modal-mode').value;
    state.pads[bank][index].volume = parseInt(document.getElementById('modal-volume').value);
    if (fileText !== 'No file assigned') {
      state.pads[bank][index].filePath = fileText;
    }

    await persistPads();
    if (bank === state.currentBank) refreshPadEl(bank, index);
    updatePadsLoaded();
    document.getElementById('modal-overlay').style.display = 'none';
  });

  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) {
      document.getElementById('modal-overlay').style.display = 'none';
    }
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('modal-overlay').style.display = 'none';
      hideContextMenu();
    }
  });
}

// ── BLUETOOTH TOGGLE ──────────────────────────────────────
function bindBtToggle() {
  const toggle = document.getElementById('bt-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    toggle.classList.toggle('on');
  });
}

// ── AUDIO STATUS ──────────────────────────────────────────
function initAudioStatus() {
  const dot = document.getElementById('audio-dot');
  const text = document.getElementById('audio-status-text');
  if (navigator.mediaDevices) {
    navigator.mediaDevices.enumerateDevices().then(devices => {
      const audioIn = devices.filter(d => d.kind === 'audioinput');
      const audioOut = devices.filter(d => d.kind === 'audiooutput');
      if (audioIn.length > 0 || audioOut.length > 0) {
        dot.className = 'status-dot active';
        const inCount = audioIn.length;
        const outCount = audioOut.length;
        text.textContent = `${inCount} In / ${outCount} Out`;
      } else {
        dot.className = 'status-dot';
        text.textContent = 'No Audio Device';
      }
    }).catch(() => {
      dot.className = 'status-dot active';
      text.textContent = 'Audio Ready';
    });
  }
}

// ── HELPERS ───────────────────────────────────────────────
function updatePadsLoaded() {
  let count = 0;
  ['A','B','C','D'].forEach(bank => {
    for (let i = 0; i < 8; i++) {
      if (state.pads[bank][i] && state.pads[bank][i].filePath) count++;
    }
  });
  const el = document.getElementById('pads-loaded');
  if (el) el.textContent = `${count} / 32`;
}
