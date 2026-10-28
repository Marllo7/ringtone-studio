// player.js — музыкальный плеер: панель снизу, очередь, MediaSession (локскрин)

import { h, toast, vibrate } from './ui.js';
import { icon } from './icons.js';
import { readTags } from './id3.js';

const ICONS = {
  play: icon('play'),
  pause: icon('pause'),
  prev: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
};

let audio = null;
let resolve = null;         // fid → track
let onEditTrack = null;

let queue = [];
let idx = -1;
let shuffle = false;
let repeat = 'off';         // off | all | one
let currentUrl = null;

let els = null;
let scrubbing = false;

const coverCache = new Map(); // fid → objectURL (мало, LRU ниже)

export function initPlayer({ resolve: res, onEditTrack: onEdit }) {
  resolve = res;
  onEditTrack = onEdit;
  audio = new Audio();
  audio.preload = 'auto';

  const bar = document.getElementById('playbar');
  bar.innerHTML = `
    <div class="pb-row">
      <div class="pb-art" aria-hidden="true">${icon('music')}</div>
      <div class="pb-meta">
        <div class="pb-title">—</div>
        <div class="pb-artist"></div>
      </div>
      <button class="pb-btn small-btn" data-act="shuffle" aria-label="Перемешать" title="Перемешать">${icon('shuffle')}</button>
      <button class="pb-btn small-btn" data-act="repeat" aria-label="Повтор" title="Повтор">${icon('repeat')}</button>
      <button class="pb-btn" data-act="prev" aria-label="Предыдущий">${ICONS.prev}</button>
      <button class="pb-btn play" data-act="toggle" aria-label="Играть/пауза">${ICONS.play}</button>
      <button class="pb-btn" data-act="next" aria-label="Следующий">${ICONS.next}</button>
      <button class="pb-btn small-btn" data-act="edit" aria-label="Обрезать трек" title="Сделать рингтон">${icon('cut')}</button>
    </div>
    <div class="pb-progress">
      <span class="pb-time" data-el="cur">0:00</span>
      <input type="range" min="0" max="1000" value="0" step="1" aria-label="Позиция">
      <span class="pb-time" data-el="dur">0:00</span>
    </div>
  `;
  els = {
    bar,
    art: bar.querySelector('.pb-art'),
    title: bar.querySelector('.pb-title'),
    artist: bar.querySelector('.pb-artist'),
    btnShuffle: bar.querySelector('[data-act=shuffle]'),
    btnRepeat: bar.querySelector('[data-act=repeat]'),
    btnToggle: bar.querySelector('[data-act=toggle]'),
    seek: bar.querySelector('input[type=range]'),
    cur: bar.querySelector('[data-el=cur]'),
    dur: bar.querySelector('[data-el=dur]'),
  };

  bar.querySelector('[data-act=toggle]').addEventListener('click', () => togglePlay());
  bar.querySelector('[data-act=next]').addEventListener('click', () => next());
  bar.querySelector('[data-act=prev]').addEventListener('click', () => prev());
  bar.querySelector('[data-act=edit]').addEventListener('click', () => {
    const t = currentTrack();
    if (t) onEditTrack?.(t);
    else toast('Сначала включите трек во вкладке «Музыка»');
  });
  els.btnShuffle.addEventListener('click', () => {
    shuffle = !shuffle;
    els.btnShuffle.classList.toggle('on', shuffle);
    toast(shuffle ? 'Перемешивание включено' : 'Перемешивание выключено', { timeout: 1600 });
  });
  els.btnRepeat.addEventListener('click', () => {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    els.btnRepeat.innerHTML = repeat === 'one' ? icon('repeatOne') : icon('repeat');
    els.btnRepeat.classList.toggle('on', repeat !== 'off');
    toast(repeat === 'off' ? 'Повтор выключен' : repeat === 'all' ? 'Повтор всей очереди' : 'Повтор одного трека', { timeout: 1600 });
  });

  els.seek.addEventListener('pointerdown', () => { scrubbing = true; });
  els.seek.addEventListener('change', () => {
    if (audio.duration) audio.currentTime = (els.seek.value / 1000) * audio.duration;
    scrubbing = false;
  });
  els.seek.addEventListener('input', () => {
    if (audio.duration) els.cur.textContent = fmt((els.seek.value / 1000) * audio.duration);
  });

  audio.addEventListener('timeupdate', () => {
    if (scrubbing) return;
    const d = isFinite(audio.duration) ? audio.duration : 0;
    els.seek.value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
    els.cur.textContent = fmt(audio.currentTime);
  });
  audio.addEventListener('loadedmetadata', () => {
    els.dur.textContent = fmt(audio.duration);
  });
  audio.addEventListener('play', () => { els.btnToggle.innerHTML = ICONS.pause; });
  audio.addEventListener('pause', () => { els.btnToggle.innerHTML = ICONS.play; });
  audio.addEventListener('ended', () => {
    if (repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    next(true);
  });
  audio.addEventListener('error', () => {
    if (idx >= 0) { toast('Не удалось воспроизвести файл, пропускаем'); next(true); }
  });

  setupMediaSession();
}

function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function playQueue(fids, startIndex = 0) {
  if (!fids?.length) return;
  queue = fids.slice();
  idx = Math.max(0, Math.min(startIndex, queue.length - 1));
  load(true);
}

export function currentTrack() {
  const fid = queue[idx];
  return fid ? resolve?.(fid) || null : null;
}

export function togglePlay() {
  if (idx < 0) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
  vibrate(6);
}

function load(autoplay) {
  const track = currentTrack();
  if (!track) return;
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  currentUrl = URL.createObjectURL(track.file);
  audio.src = currentUrl;
  els.bar.classList.remove('hidden');
  els.title.textContent = track.title || track.name;
  els.artist.textContent = track.artist || '';
  els.cur.textContent = '0:00';
  els.dur.textContent = track.duration ? fmt(track.duration) : '—';
  setArt(null);
  loadCoverAsync(track);
  document.dispatchEvent(new CustomEvent('rs:playing', { detail: track.fid }));
  if (autoplay) audio.play().catch(() => {});
  updateMediaSession(track);
}

function setArt(url) {
  if (url) els.art.innerHTML = `<img src="${url}" alt="">`;
  else els.art.innerHTML = icon('music');
}

async function loadCoverAsync(track) {
  const fid = track.fid;
  if (coverCache.has(fid)) {
    setArt(coverCache.get(fid));
    return;
  }
  try {
    const tags = await readTags(track.file, { withCover: true });
    if (queue[idx] !== fid) return; // трек уже сменился
    if (tags.cover) {
      const url = URL.createObjectURL(tags.cover);
      if (coverCache.size > 12) {
        const first = coverCache.keys().next().value;
        const old = coverCache.get(first);
        coverCache.delete(first);
        URL.revokeObjectURL(old);
      }
      coverCache.set(fid, url);
      setArt(url);
      updateMediaSession(track, url);
    }
  } catch { /* без обложки */ }
}

function next(auto = false) {
  if (!queue.length) return;
  if (shuffle && queue.length > 1) {
    let n;
    do { n = Math.floor(Math.random() * queue.length); } while (n === idx);
    idx = n;
  } else if (idx + 1 < queue.length) {
    idx++;
  } else if (repeat === 'all' || !auto) {
    idx = 0;
  } else {
    audio.pause();
    return;
  }
  load(true);
}

function prev() {
  if (!queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (shuffle && queue.length > 1) {
    let n;
    do { n = Math.floor(Math.random() * queue.length); } while (n === idx);
    idx = n;
  } else {
    idx = idx > 0 ? idx - 1 : queue.length - 1;
  }
  load(true);
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  } catch { /* отдельные действия могут не поддерживаться */ }
}

function updateMediaSession(track, artUrl) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || track.name,
      artist: track.artist || '',
      album: 'Ringtone Studio',
      artwork: artUrl ? [{ src: artUrl, sizes: '512x512' }] : [],
    });
  } catch { /* нет MediaMetadata */ }
}
