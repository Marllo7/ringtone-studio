// engine.js — аудио-ядро: декодирование, волна, обрезка, воспроизведение отрезка

let _ctx = null;

export function getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

export function unlockAudio() {
  const c = getCtx();
  if (c.state === 'suspended') c.resume().catch(() => {});
}

export async function decodeAudio(file) {
  const ab = await file.arrayBuffer();
  const ctx = getCtx();
  return await ctx.decodeAudioData(ab);
}

/** Анализ буфера: моно-микс + «мип-карта» пиков + энергия для поиска громких мест */
export function analyze(buffer) {
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const chs = buffer.numberOfChannels;
  const mono = new Float32Array(len);
  for (let c = 0; c < chs; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i];
  }
  if (chs > 1) for (let i = 0; i < len; i++) mono[i] /= chs;

  const bucket = 2048;
  const nB = Math.max(1, Math.ceil(len / bucket));
  const mins = new Float32Array(nB);
  const maxs = new Float32Array(nB);
  const energy = new Float32Array(nB);

  for (let b = 0; b < nB; b++) {
    const s = b * bucket;
    const e = Math.min(len, s + bucket);
    let mn = 0, mx = 0, sum = 0;
    for (let i = s; i < e; i++) {
      const v = mono[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v * v;
    }
    mins[b] = mn;
    maxs[b] = mx;
    energy[b] = sum / Math.max(1, e - s); // средний квадрат (RMS²)
  }

  return { sr, len, duration: buffer.duration, mono, bucket, nB, mins, maxs, energy };
}

/** Пики для отрисовки диапазона [fromSec..toSec] шириной width пикселей */
export function peaksFor(a, fromSec, toSec, width) {
  const from = clamp(Math.round(fromSec * a.sr), 0, a.len);
  const to = clamp(Math.round(toSec * a.sr), from, a.len);
  const w = Math.max(1, Math.floor(width));
  const mins = new Float32Array(w);
  const maxs = new Float32Array(w);
  const span = to - from;
  if (span <= 0) return { mins, maxs };

  const per = span / w; // сэмплов на пиксель

  if (per >= a.bucket) {
    // быстрый путь по мип-карте
    for (let x = 0; x < w; x++) {
      const s0 = Math.floor((from + x * per) / a.bucket);
      const s1 = Math.max(s0 + 1, Math.ceil((from + (x + 1) * per) / a.bucket));
      let mn = 0, mx = 0;
      for (let b = s0; b < s1 && b < a.nB; b++) {
        if (a.mins[b] < mn) mn = a.mins[b];
        if (a.maxs[b] > mx) mx = a.maxs[b];
      }
      mins[x] = mn; maxs[x] = mx;
    }
  } else {
    // точный путь по моно-миксу
    for (let x = 0; x < w; x++) {
      const s0 = Math.floor(from + x * per);
      const s1 = Math.min(a.len, Math.max(s0 + 1, Math.floor(from + (x + 1) * per)));
      let mn = 0, mx = 0;
      for (let i = s0; i < s1; i++) {
        const v = a.mono[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      mins[x] = mn; maxs[x] = mx;
    }
  }
  return { mins, maxs };
}

/** Поиск самого громкого окна длиной sec секунд. Возвращает время начала (сек) */
export function findLoudest(a, sec) {
  const bucketSec = a.bucket / a.sr;
  const w = Math.max(1, Math.round(sec / bucketSec));
  const n = a.nB;
  if (n === 0) return 0;
  if (w >= n) return 0;
  // префиксные суммы энергии
  let sum = 0;
  for (let i = 0; i < w; i++) sum += a.energy[i];
  let best = sum, bestStart = 0;
  for (let i = w; i < n; i++) {
    sum += a.energy[i] - a.energy[i - w];
    if (sum > best) { best = sum; bestStart = i - w + 1; }
  }
  let start = bestStart * bucketSec;
  if (start + sec > a.duration) start = Math.max(0, a.duration - sec);
  return start;
}

/** Рендер фрагмента [start..end] в новый буфер: фейды + громкость без клиппинга */
export function renderClip(buffer, start, end, fadeIn, fadeOut, gainDb) {
  const sr = buffer.sampleRate;
  const chs = buffer.numberOfChannels;
  const s0 = clamp(Math.floor(start * sr), 0, buffer.length);
  const s1 = clamp(Math.ceil(end * sr), s0, buffer.length);
  const n = s1 - s0;
  const gain = Math.pow(10, gainDb / 20);

  // пик фрагмента для авто-ограничения громкости
  let peak = 0;
  for (let c = 0; c < chs; c++) {
    const d = buffer.getChannelData(c);
    for (let i = s0; i < s1; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  const scale = Math.min(1, 0.98 / Math.max(1e-6, peak * gain));
  const g = gain * scale;

  const out = getCtx().createBuffer(chs, n, sr);
  const fi = Math.max(0, Math.round((fadeIn || 0) * sr));
  const fo = Math.max(0, Math.round((fadeOut || 0) * sr));

  for (let c = 0; c < chs; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let k = g;
      if (fi > 0 && i < fi) {
        const t = i / fi;
        k *= 0.5 - 0.5 * Math.cos(Math.PI * t); // плавный подъём
      }
      if (fo > 0 && i >= n - fo) {
        const t = (n - i) / fo;
        k *= 0.5 - 0.5 * Math.cos(Math.PI * t); // плавное затухание
      }
      dst[i] = src[s0 + i] * k;
    }
  }
  return out;
}

/** Воспроизведение отрезка буфера. Возвращает { stop, position } */
export function playRange(buffer, start, end, { loop = false, onEnded } = {}) {
  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const t0 = ctx.currentTime;
  let stopped = false;
  if (loop) {
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = Math.max(start + 0.01, end);
    src.start(0, start);
  } else {
    src.start(0, start, Math.max(0.01, end - start));
  }
  src.onended = () => { if (!stopped) onEnded?.(); };
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      src.onended = null;
      try { src.stop(); } catch { /* уже остановлен */ }
    },
    position() {
      const elapsed = ctx.currentTime - t0;
      if (loop) return start + (elapsed % Math.max(0.01, end - start));
      return start + elapsed;
    },
    get stopped() { return stopped; },
  };
}

/* ===== Утилиты ===== */

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export function fmtTime(sec, frac = false) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${m}:${String(s).padStart(2, '0')}`;
  if (!frac) return base;
  const t = Math.floor((sec % 1) * 10);
  return `${base}.${t}`;
}

export function fmtBytes(b) {
  if (!isFinite(b) || b <= 0) return '0 МБ';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} КБ`;
  return `${(b / (1024 * 1024)).toFixed(1)} МБ`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'webm', 'aiff', 'aif', 'mp4', 'm4b']);
export function isAudioName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return !!m && AUDIO_EXT.has(m[1].toLowerCase());
}

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** «01. Artist - Title.mp3» → { artist, title } */
export function trackInfoFromName(name) {
  let base = (name || '').replace(/\.[a-z0-9]+$/i, '');
  base = base.replace(/^\s*\d{1,3}[\s.\-_]+/, ''); // номер трека в начале
  const m = /^(.*?)\s+[-–—]\s+(.*)$/.exec(base);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: base.trim() };
}

export function fidOf(file) { return `${file.name}::${file.size}`; }
