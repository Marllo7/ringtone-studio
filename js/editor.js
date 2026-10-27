// editor.js — визуальный редактор рингтонов: волна, выделение, фейды, сохранение

import { h, modal, toast, vibrate } from './ui.js';
import { unlockAudio, decodeAudio, analyze, peaksFor, findLoudest, renderClip, playRange, clamp, fmtTime } from './engine.js';
import {
  saveRingtone, downloadBlob, shareFile, encodeMP3, sanitizeFilename,
  pickOutputDir, writeToDir, canPickDir,
} from './export.js';
import { refresh as refreshRingtones } from './ringtones.js';

const state = {
  track: null,
  buffer: null,
  an: null,
  sel: { start: 0, end: 30 },
  view: { start: 0, end: 30 },
  loop: false,
  nudgeTarget: 'start',
  lastLen: 30,
  fade: { in: 0, out: 0.3 },
  volPct: 100,
  playing: null,
  raf: 0,
  saving: false,
  loadToken: 0,
};

let view = null;
const els = {};
let cbPickTrack = null;
let cbShowHelp = null;

/* ================= Инициализация ================= */

export function initEditor({ pickTrack, showHelp }) {
  cbPickTrack = pickTrack;
  cbShowHelp = showHelp;
  view = document.getElementById('view-editor');

  view.innerHTML = `
    <div id="editor-empty"></div>
    <div id="editor-ui" class="hidden" style="display:flex;flex-direction:column;gap:14px">
      <div class="editor-head">
        <div style="font-size:26px" aria-hidden="true">✂️</div>
        <div class="grow">
          <div class="e-title"></div>
          <div class="e-sub"></div>
        </div>
        <button class="btn small ghost" data-el="change">Другой трек</button>
      </div>

      <div class="wave-card">
        <div class="wave-wrap">
          <canvas id="wave-canvas" aria-label="Волна аудио"></canvas>
          <div class="playhead" data-el="playhead"></div>
          <div class="wave-loading hidden" data-el="loading">
            <div class="spinner"></div><div>Читаем и рисуем волну…</div>
          </div>
        </div>
        <div class="time-grid">
          <div class="time-cell">
            <label>Начало</label>
            <input type="number" min="0" step="0.01" inputmode="decimal" data-el="start">
            <div class="tc-sub" data-el="startFmt"></div>
          </div>
          <div class="time-cell">
            <label>Конец</label>
            <input type="number" min="0" step="0.01" inputmode="decimal" data-el="end">
            <div class="tc-sub" data-el="endFmt"></div>
          </div>
          <div class="time-cell">
            <label>Длина</label>
            <input type="number" min="0" step="0.01" data-el="len" disabled>
            <div class="tc-sub" data-el="lenFmt"></div>
          </div>
        </div>
        <div class="mini-wrap"><canvas id="mini-canvas" aria-label="Мини-карта дорожки"></canvas></div>
      </div>

      <div class="ctl-card">
        <div class="ctl-row">
          <button class="btn primary" data-el="preview" style="flex:2">▶ Прослушать</button>
          <button class="btn ghost" data-el="loop" style="flex:1">🔁 Петля</button>
        </div>
        <div class="ctl-row">
          <button class="btn ghost" data-el="zoomOut" aria-label="Отдалить" style="flex:1">−</button>
          <button class="btn ghost" data-el="fit" style="flex:2">Вся дорожка</button>
          <button class="btn ghost" data-el="zoomIn" aria-label="Приблизить" style="flex:1">＋</button>
        </div>
        <div class="ctl-row" data-el="nudgeSegWrap">
          <div class="seg" data-el="nudgeTarget" style="flex:1">
            <button data-t="start" class="active" type="button">Начало</button>
            <button data-t="end" type="button">Конец</button>
          </div>
        </div>
        <div class="nudge-grid">
          <button class="nudge-btn" data-n="-1" type="button">−1 с</button>
          <button class="nudge-btn" data-n="-0.1" type="button">−0,1 с</button>
          <button class="nudge-btn" data-n="-0.01" type="button">−0,01 с</button>
          <button class="nudge-btn" data-n="0.01" type="button">+0,01 с</button>
          <button class="nudge-btn" data-n="0.1" type="button">+0,1 с</button>
          <button class="nudge-btn" data-n="1" type="button">+1 с</button>
        </div>
        <div class="ctl-row">
          <button class="btn" data-el="loud" style="flex:1">🎯 Громкое место</button>
          <button class="btn ghost" data-len="15" style="flex:0 0 auto">15 с</button>
          <button class="btn ghost" data-len="30" style="flex:0 0 auto">30 с</button>
          <button class="btn ghost" data-len="45" style="flex:0 0 auto">45 с</button>
        </div>
        <div class="slider-row">
          <span class="sl-label">Плавный старт</span>
          <input type="range" min="0" max="3" step="0.05" data-el="fadeIn">
          <span class="sl-val" data-el="fadeInVal">0 с</span>
        </div>
        <div class="slider-row">
          <span class="sl-label">Плавный финиш</span>
          <input type="range" min="0" max="3" step="0.05" data-el="fadeOut">
          <span class="sl-val" data-el="fadeOutVal">0,3 с</span>
        </div>
        <div class="slider-row">
          <span class="sl-label">Громкость</span>
          <input type="range" min="50" max="160" step="5" data-el="vol">
          <span class="sl-val" data-el="volVal">100%</span>
        </div>
        <button class="btn primary block" data-el="save" style="min-height:54px;font-size:17px">💾 Создать рингтон</button>
        <div class="ctl-note">Отрезок сохранится в приложение и в «Загрузки» телефона. Как поставить на звонок — кнопка «?» сверху.</div>
      </div>
    </div>
  `;

  els.empty = view.querySelector('#editor-empty');
  els.ui = view.querySelector('#editor-ui');
  els.headTitle = view.querySelector('.e-title');
  els.headSub = view.querySelector('.e-sub');
  els.wave = view.querySelector('#wave-canvas');
  els.mini = view.querySelector('#mini-canvas');
  els.playhead = view.querySelector('[data-el=playhead]');
  els.loading = view.querySelector('[data-el=loading]');
  els.inStart = view.querySelector('[data-el=start]');
  els.inEnd = view.querySelector('[data-el=end]');
  els.inLen = view.querySelector('[data-el=len]');
  els.fStart = view.querySelector('[data-el=startFmt]');
  els.fEnd = view.querySelector('[data-el=endFmt]');
  els.fLen = view.querySelector('[data-el=lenFmt]');
  els.btnPreview = view.querySelector('[data-el=preview]');
  els.btnLoop = view.querySelector('[data-el=loop]');
  els.btnLoud = view.querySelector('[data-el=loud]');
  els.slFadeIn = view.querySelector('[data-el=fadeIn]');
  els.slFadeOut = view.querySelector('[data-el=fadeOut]');
  els.slVol = view.querySelector('[data-el=vol]');
  els.btnChange = view.querySelector('[data-el=change]');

  renderEmpty();

  // ==== события ====
  view.querySelector('[data-el=change]').addEventListener('click', () => cbPickTrack?.());
  els.btnPreview.addEventListener('click', () => { stopPreview(); startPreview(); });
  els.btnLoop.addEventListener('click', () => {
    state.loop = !state.loop;
    els.btnLoop.classList.toggle('primary', state.loop);
    els.btnLoop.classList.toggle('ghost', !state.loop);
  });
  view.querySelector('[data-el=zoomIn]').addEventListener('click', () => zoom(1.8));
  view.querySelector('[data-el=zoomOut]').addEventListener('click', () => zoom(1 / 1.8));
  view.querySelector('[data-el=fit]').addEventListener('click', () => { state.view = { start: 0, end: state.an ? state.an.duration : 1 }; redrawAll(); });
  view.querySelectorAll('[data-el=nudgeTarget] button').forEach(b =>
    b.addEventListener('click', () => {
      state.nudgeTarget = b.dataset.t;
      view.querySelectorAll('[data-el=nudgeTarget] button').forEach(x => x.classList.toggle('active', x === b));
    }));
  view.querySelectorAll('.nudge-btn').forEach(b =>
    b.addEventListener('click', () => nudge(parseFloat(b.dataset.n))));
  els.btnLoud.addEventListener('click', gotoLoudest);
  view.querySelectorAll('[data-len]').forEach(b =>
    b.addEventListener('click', () => setLength(parseInt(b.dataset.len, 10))));
  els.slFadeIn.value = state.fade.in;
  els.slFadeOut.value = state.fade.out;
  els.slVol.value = state.volPct;
  els.slFadeIn.addEventListener('input', () => { state.fade.in = +els.slFadeIn.value; view.querySelector('[data-el=fadeInVal]').textContent = fmtSec(state.fade.in); });
  els.slFadeOut.addEventListener('input', () => { state.fade.out = +els.slFadeOut.value; view.querySelector('[data-el=fadeOutVal]').textContent = fmtSec(state.fade.out); });
  els.slVol.addEventListener('input', () => { state.volPct = +els.slVol.value; view.querySelector('[data-el=volVal]').textContent = state.volPct + '%'; });
  view.querySelector('[data-el=save]').addEventListener('click', openSaveSheet);

  els.inStart.addEventListener('change', () => {
    if (!state.an) return;
    const v = clamp(+els.inStart.value || 0, 0, state.an.duration);
    state.sel.start = Math.min(v, state.sel.end - 0.05);
    ensureVisible();
    redrawAll();
  });
  els.inEnd.addEventListener('change', () => {
    if (!state.an) return;
    const v = clamp(+els.inEnd.value || 0, 0, state.an.duration);
    state.sel.end = Math.max(v, state.sel.start + 0.05);
    ensureVisible();
    redrawAll();
  });

  bindCanvas();
  bindMini();
  new ResizeObserver(() => redrawAll()).observe(els.wave);

  document.addEventListener('keydown', onKeydown);
}

function fmtSec(s) {
  return `${(Math.round(s * 100) / 100).toString().replace('.', ',')} с`;
}

function renderEmpty() {
  els.ui.classList.add('hidden');
  els.empty.classList.remove('hidden');
  els.empty.innerHTML = `
    <div class="empty-state">
      <span class="e-ico">✂️</span>
      <div class="e-title">Редактор рингтонов</div>
      <p>Выберите песню из библиотеки — появится волна.
      Выделите кусок пальцем, послушайте и сохраните.</p>
      <button class="btn primary" data-act="pick">🎵 Выбрать трек</button>
    </div>`;
  els.empty.querySelector('[data-act=pick]').addEventListener('click', () => cbPickTrack?.());
}

export function hasTrack() { return !!state.track; }

export function pickTrack() { cbPickTrack?.(); }

/* ================= Загрузка трека ================= */

export async function openTrack(track) {
  if (!track) return;
  const token = ++state.loadToken;
  stopPreview();
  state.track = track;
  state.buffer = null;
  state.an = null;
  els.empty.classList.add('hidden');
  els.ui.classList.remove('hidden');
  els.loading.classList.remove('hidden');
  els.headTitle.textContent = track.title || track.name;
  els.headSub.textContent = track.artist || track.name;
  try {
    unlockAudio();
    state.buffer = await decodeAudio(track.file);
    state.an = analyze(state.buffer);
  } catch (e) {
    if (state.loadToken !== token) return;
    els.loading.classList.add('hidden');
    toast('Не удалось прочитать файл — формат не поддерживается браузером');
    renderEmpty();
    return;
  }
  if (state.loadToken !== token) return;
  const dur = state.an.duration;
  state.sel = { start: 0, end: Math.min(state.lastLen || 30, dur) };
  state.view = { start: 0, end: dur };
  els.loading.classList.add('hidden');
  redrawAll();
  vibrate(8);
}

/* ================= Отрисовка ================= */

function redrawAll() {
  if (!state.an) return;
  drawWave();
  drawMini();
  updateInputs();
}

function timeToX(t) {
  const span = state.view.end - state.view.start;
  return ((t - state.view.start) / span) * els.wave.clientWidth;
}
function xToTime(x) {
  const span = state.view.end - state.view.start;
  return state.view.start + (x / els.wave.clientWidth) * span;
}

function drawWave() {
  const c = els.wave;
  const W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(W * dpr)) c.width = Math.round(W * dpr);
  if (c.height !== Math.round(H * dpr)) c.height = Math.round(H * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const rulerH = 18;
  const waveTop = rulerH;
  const waveH = H - rulerH;
  const mid = waveTop + waveH / 2;
  const amp = waveH / 2 - 8;

  const { mins, maxs } = peaksFor(state.an, state.view.start, state.view.end, W);

  // волна
  const inSel = (x) => {
    const t = xToTime(x + 0.5);
    return t >= state.sel.start && t <= state.sel.end;
  };
  for (let x = 0; x < W; x++) {
    const y1 = mid - maxs[x] * amp;
    const y2 = mid - mins[x] * amp;
    ctx.fillStyle = inSel(x) ? '#ffc29e' : 'rgba(154,167,232,.75)';
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }

  // фон выделения
  const x0 = timeToX(state.sel.start);
  const x1 = timeToX(state.sel.end);
  ctx.fillStyle = 'rgba(255,122,61,.10)';
  ctx.fillRect(x0, waveTop, x1 - x0, waveH);
  ctx.strokeStyle = '#ff7a3d';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, waveTop); ctx.lineTo(x0, waveTop + waveH);
  ctx.moveTo(x1, waveTop); ctx.lineTo(x1, waveTop + waveH);
  ctx.stroke();

  // линейка
  const span = state.view.end - state.view.start;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (W * (s / span) >= 64) { step = s; break; }
  }
  ctx.fillStyle = 'rgba(139,147,167,.9)';
  ctx.strokeStyle = 'rgba(139,147,167,.25)';
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (let t = Math.ceil(state.view.start / step) * step; t <= state.view.end; t += step) {
    const x = timeToX(t);
    if (x < 0 || x > W) continue;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 2); ctx.lineTo(x + 0.5, rulerH);
    ctx.stroke();
    ctx.fillText(fmtTime(t, step < 1), x + 3, 12);
  }

  // ручки выделения
  drawHandle(ctx, x0, waveTop, waveH);
  drawHandle(ctx, x1, waveTop, waveH);
}

function drawHandle(ctx, x, top, h) {
  const W = els.wave.clientWidth;
  if (x < -14 || x > W + 14) return;
  const w = 10, hh = Math.min(46, h - 10);
  const y = top + h / 2 - hh / 2;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ff7a3d';
  ctx.lineWidth = 2;
  const r = 5;
  ctx.beginPath();
  ctx.moveTo(x - w / 2 + r, y);
  ctx.arcTo(x + w / 2, y, x + w / 2, y + hh, r);
  ctx.arcTo(x + w / 2, y + hh, x - w / 2, y + hh, r);
  ctx.arcTo(x - w / 2, y + hh, x - w / 2, y, r);
  ctx.arcTo(x - w / 2, y, x + w / 2, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawMini() {
  const c = els.mini;
  const W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(W * dpr)) c.width = Math.round(W * dpr);
  if (c.height !== Math.round(H * dpr)) c.height = Math.round(H * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const { mins, maxs } = peaksFor(state.an, 0, state.an.duration, W);
  const mid = H / 2, amp = H / 2 - 4;
  const dur = state.an.duration;
  for (let x = 0; x < W; x++) {
    const y1 = mid - maxs[x] * amp;
    const y2 = mid - mins[x] * amp;
    ctx.fillStyle = 'rgba(154,167,232,.5)';
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  // выделение
  const x0 = (state.sel.start / dur) * W;
  const x1 = (state.sel.end / dur) * W;
  ctx.fillStyle = 'rgba(255,122,61,.25)';
  ctx.fillRect(x0, 0, x1 - x0, H);
  ctx.strokeStyle = '#ff7a3d';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, 0); ctx.lineTo(x0, H);
  ctx.moveTo(x1, 0); ctx.lineTo(x1, H);
  ctx.stroke();
  // окно просмотра
  const v0 = (state.view.start / dur) * W;
  const v1 = (state.view.end / dur) * W;
  ctx.strokeStyle = 'rgba(255,255,255,.65)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(v0 + 0.5, 1, v1 - v0 - 1, H - 2);
}

function updateInputs() {
  const s = state.sel;
  if (document.activeElement !== els.inStart) els.inStart.value = (Math.round(s.start * 100) / 100).toFixed(2);
  if (document.activeElement !== els.inEnd) els.inEnd.value = (Math.round(s.end * 100) / 100).toFixed(2);
  els.inLen.value = (Math.round((s.end - s.start) * 100) / 100).toFixed(2);
  els.fStart.textContent = fmtTime(s.start, true);
  els.fEnd.textContent = fmtTime(s.end, true);
  els.fLen.textContent = fmtTime(s.end - s.start, true);
}

/* ================= Взаимодействие с волной ================= */

function bindCanvas() {
  const c = els.wave;
  let mode = null; // 'start' | 'end' | 'move' | 'new'
  let anchor = 0;
  let grabOff = 0;

  const hit = (x) => {
    const s = state.sel;
    if (s.end - s.start < 0.05) return null;
    const xs = timeToX(s.start), xe = timeToX(s.end);
    if (Math.abs(x - xs) <= 18 && Math.abs(x - xs) <= Math.abs(x - xe)) return 'start';
    if (Math.abs(x - xe) <= 18) return 'end';
    return null;
  };

  c.addEventListener('pointerdown', (e) => {
    if (!state.an) return;
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    const x = e.offsetX;
    const t = xToTime(x);
    const h = hit(x);
    if (h) { mode = h === 'start' ? 'start' : 'end'; }
    else if (t > state.sel.start && t < state.sel.end) { mode = 'move'; grabOff = t - state.sel.start; }
    else { mode = 'new'; anchor = t; state.sel = { start: t, end: t }; }
    stopPreview();
    redrawAll();
  });

  c.addEventListener('pointermove', (e) => {
    if (!mode || !state.an) return;
    e.preventDefault();
    const t = clamp(xToTime(e.offsetX), 0, state.an.duration);
    const len = state.sel.end - state.sel.start;
    if (mode === 'start') {
      state.sel.start = Math.min(t, state.sel.end - 0.05);
    } else if (mode === 'end') {
      state.sel.end = Math.max(t, state.sel.start + 0.05);
    } else if (mode === 'move') {
      const ns = clamp(t - grabOff, 0, state.an.duration - len);
      state.sel = { start: ns, end: ns + len };
    } else if (mode === 'new') {
      state.sel = t >= anchor ? { start: anchor, end: t } : { start: t, end: anchor };
      if (state.sel.end - state.sel.start < 0.05) state.sel.end = Math.min(state.an.duration, state.sel.start + 0.05);
    }
    redrawAll();
  });

  const finish = (e) => {
    if (!mode) return;
    const wasTap = mode === 'new' && (state.sel.end - state.sel.start) <= 0.08;
    mode = null;
    if (wasTap && state.an) {
      const t = clamp(xToTime(e.offsetX), 0, state.an.duration);
      const L = Math.min(state.lastLen || 30, state.an.duration);
      let ns = t;
      if (ns + L > state.an.duration) ns = Math.max(0, state.an.duration - L);
      state.sel = { start: ns, end: ns + L };
      ensureVisible();
    }
    state.lastLen = Math.max(0.3, state.sel.end - state.sel.start);
    redrawAll();
    vibrate(5);
  };
  c.addEventListener('pointerup', finish);
  c.addEventListener('pointercancel', finish);
}

function bindMini() {
  const c = els.mini;
  let drag = false;
  const moveTo = (e) => {
    if (!state.an) return;
    const t = clamp((e.offsetX / c.clientWidth) * state.an.duration, 0, state.an.duration);
    const len = state.view.end - state.view.start;
    let s = t - len / 2;
    s = clamp(s, 0, state.an.duration - len);
    state.view = { start: s, end: s + len };
    redrawAll();
  };
  c.addEventListener('pointerdown', (e) => { drag = true; c.setPointerCapture(e.pointerId); moveTo(e); e.preventDefault(); });
  c.addEventListener('pointermove', (e) => { if (drag) moveTo(e); });
  c.addEventListener('pointerup', () => { drag = false; });
  c.addEventListener('pointercancel', () => { drag = false; });
}

/* ================= Зум и навигация ================= */

function zoom(f) {
  if (!state.an) return;
  const dur = state.an.duration;
  const len = clamp((state.view.end - state.view.start) / f, 0.05, dur);
  const sc = (state.sel.start + state.sel.end) / 2;
  const vc = (state.view.start + state.view.end) / 2;
  const center = (sc >= state.view.start && sc <= state.view.end) ? sc : vc;
  let s = clamp(center - len / 2, 0, dur - len);
  state.view = { start: s, end: s + len };
  redrawAll();
}

function ensureVisible() {
  if (!state.an) return;
  const dur = state.an.duration;
  const len = state.view.end - state.view.start;
  if (state.sel.start < state.view.start || state.sel.end > state.view.end) {
    let s = clamp((state.sel.start + state.sel.end) / 2 - len / 2, 0, dur - len);
    state.view = { start: s, end: s + len };
  }
}

function nudge(d) {
  if (!state.an) return;
  stopPreview();
  if (state.nudgeTarget === 'start') {
    state.sel.start = clamp(state.sel.start + d, 0, state.sel.end - 0.05);
  } else {
    state.sel.end = clamp(state.sel.end + d, state.sel.start + 0.05, state.an.duration);
  }
  state.lastLen = Math.max(0.3, state.sel.end - state.sel.start);
  ensureVisible();
  redrawAll();
}

function setLength(L) {
  if (!state.an) return;
  stopPreview();
  const dur = state.an.duration;
  let s = state.sel.start;
  if (s + L > dur) s = Math.max(0, dur - L);
  state.sel = { start: s, end: Math.min(dur, s + L) };
  state.lastLen = L;
  ensureVisible();
  redrawAll();
}

function gotoLoudest() {
  if (!state.an) return;
  stopPreview();
  const dur = state.an.duration;
  const L = clamp(state.sel.end - state.sel.start || 30, 3, 120);
  const t = findLoudest(state.an, L);
  state.sel = { start: t, end: Math.min(dur, t + L) };
  ensureVisible();
  redrawAll();
  toast('Нашли самое громкое место 🎯', { timeout: 2000 });
}

/* ================= Прослушивание ================= */

function startPreview() {
  if (!state.an || state.playing) return;
  const s = state.sel;
  if (s.end - s.start < 0.15) { toast('Выделите отрезок на волне'); return; }
  unlockAudio();
  state.playing = playRange(state.buffer, s.start, s.end, {
    loop: state.loop,
    onEnded: () => stopPreview(),
  });
  els.btnPreview.innerHTML = '⏹ Стоп';
  els.playhead.style.display = 'block';
  const tick = () => {
    if (!state.playing) return;
    const t = state.playing.position();
    const x = timeToX(t);
    els.playhead.style.left = `${x}px`;
    // автопрокрутка окна
    if (t > state.view.end - (state.view.end - state.view.start) * 0.08) {
      const len = state.view.end - state.view.start;
      let st = clamp(t - len * 0.2, 0, state.an.duration - len);
      state.view = { start: st, end: st + len };
      drawWave(); drawMini();
    }
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

export function stopPreview() {
  if (state.playing) {
    state.playing.stop();
    state.playing = null;
    cancelAnimationFrame(state.raf);
    els.playhead.style.display = 'none';
    els.btnPreview.innerHTML = '▶ Прослушать';
  }
}

/* ================= Сохранение ================= */

function gainDb() {
  return 20 * Math.log10(state.volPct / 100);
}

function openSaveSheet() {
  if (!state.an || !state.track) { toast('Сначала выберите трек'); return; }
  const s = state.sel;
  if (s.end - s.start < 0.3) { toast('Отрезок слишком короткий — выделите хотя бы 0,3 с'); return; }
  stopPreview();
  const tr = state.track;
  const name0 = sanitizeFilename(`${tr.artist ? tr.artist + ' — ' : ''}${tr.title || tr.name}`) + ' (рингтон)';
  const canDir = canPickDir();

  const el = h(`<div>
      <div class="sheet-title"><span class="grow">💾 Создать рингтон</span></div>
      <div class="field"><label>Название</label><input type="text" maxlength="80" spellcheck="false"></div>
      <div class="field"><label>Качество MP3</label>
        <select>
          <option value="192" selected>192 кбит/с — рекомендуется</option>
          <option value="320">320 кбит/с — максимальное</option>
          <option value="128">128 кбит/с — маленький файл</option>
        </select>
      </div>
      <div class="help-note">Длительность: <b data-el="lenLbl"></b> • без потери качества звука при нарезке</div>
      <div class="sheet-actions">
        <button class="btn primary" data-mode="download">💾 Сохранить и скачать</button>
        <button class="btn" data-mode="share">↗ Поделиться файлом</button>
        ${canDir ? '<button class="btn" data-mode="dir">📁 Сохранить в папку…</button>' : ''}
        <button class="btn ghost" data-mode="app">Только в приложение</button>
      </div>
      <div class="help-note">«Поделиться» на Android открывает системное меню — там можно сохранить файл в «Файлы», в том числе на SD-карту.</div>
    </div>`);
  const nameInput = el.querySelector('input');
  nameInput.value = name0;
  el.querySelector('[data-el=lenLbl]').textContent = fmtTime(s.end - s.start, true);
  const bitrateSel = el.querySelector('select');

  const m = modal(el);
  el.querySelectorAll('[data-mode]').forEach(b =>
    b.addEventListener('click', () => { m.close(); doSave(b.dataset.mode, { name: () => nameInput.value.trim() || name0, bitrate: () => +bitrateSel.value }); }));
}

async function doSave(mode, { name, bitrate }) {
  if (state.saving) return;
  state.saving = true;
  const tr = state.track;
  const s = state.sel;
  const t = toast('Готовим отрезок…', { timeout: 0 });
  try {
    const clip = renderClip(state.buffer, s.start, s.end, state.fade.in, state.fade.out, gainDb());
    const blob = await encodeMP3(clip, {
      bitrate: bitrate(),
      onProgress: (p) => t.update(`Кодирование MP3… ${Math.round(p * 100)}%`),
    });
    const title = sanitizeFilename(name());
    const rec = await saveRingtone({
      title, artist: tr.artist || '', mp3: blob,
      duration: s.end - s.start, sampleRate: clip.sampleRate, bitrate: bitrate(),
    });
    refreshRingtones();

    if (mode === 'download') {
      downloadBlob(blob, `${title}.mp3`);
      toast(`Рингтон «${title}» готов — файл в «Загрузках»`, {
        actionLabel: 'Как поставить?',
        onAction: () => cbShowHelp?.(),
      });
    } else if (mode === 'share') {
      const res = await shareFile(blob, `${title}.mp3`, title);
      if (res === 'shared') toast('Рингтон отправлен');
      else if (res === 'downloaded') toast('Файл сохранён в «Загрузках»');
    } else if (mode === 'dir') {
      const dir = await pickOutputDir();
      if (dir) {
        const ok = await writeToDir(dir, blob, `${title}.mp3`);
        if (ok) toast(`Сохранено: ${ok}`);
        else toast('Не удалось записать файл в папку');
      }
    } else {
      toast(`Рингтон «${title}» сохранён в приложении`, {
        actionLabel: 'Открыть',
        onAction: () => document.dispatchEvent(new CustomEvent('rs:goto', { detail: 'ringtones' })),
      });
    }
    vibrate([12, 40, 12]);
  } catch (e) {
    toast('Не удалось сохранить рингтон: ' + (e?.message || 'ошибка'));
  } finally {
    t.close();
    state.saving = false;
  }
}

/* ================= Клавиатура (для теста с ПК) ================= */

function onKeydown(e) {
  if (view.classList.contains('hidden') || !state.an) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (document.querySelector('.modal-backdrop')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state.playing) stopPreview();
    else startPreview();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    nudge(e.shiftKey ? -1 : -0.05);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    nudge(e.shiftKey ? 1 : 0.05);
  }
}
