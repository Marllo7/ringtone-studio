// export.js — сохранение рингтонов: MP3 (воркер), скачивание, share, запись в папку

import { dbGet, dbGetAll, dbPut, dbDelete, newId } from './db.js';

/** Скачивание файла на устройство (в «Загрузки»). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Поделиться файлом через системное меню
 *  (Android: «Файлы» → можно сохранить куда угодно, включая SD-карту). */
export async function shareFile(blob, filename, title) {
  try {
    const file = new File([blob], filename, { type: blob.type || 'audio/mpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: title || filename });
      return 'shared';
    }
  } catch (e) {
    if (e?.name === 'AbortError') return 'abort';
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

/** Запрос persistent-хранилища, чтобы рингтоны не вычищал браузер. */
export async function ensurePersistent() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* нет API */ }
  return false;
}

/* ===== Запись в выбранную папку (desktop Chrome: можно выбрать любую папку/диск) ===== */

export const canPickDir = () => 'showDirectoryPicker' in window;

/** Выбор папки для сохранения + права на запись. */
export async function pickOutputDir() {
  if (!canPickDir()) return null;
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await dbPut('handles', { id: 'outputDir', name: dir.name, handle: dir });
    await ensurePersistent();
    return dir;
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    return null;
  }
}

/** Последняя выбранная папка сохранения (или null). */
export async function savedOutputDirName() {
  try {
    const rec = await dbGet('handles', 'outputDir');
    return rec?.name || null;
  } catch { return null; }
}

export async function savedOutputDir() {
  try {
    const rec = await dbGet('handles', 'outputDir');
    return rec?.handle || null;
  } catch { return null; }
}

/** Запись файла в папку, возвращает имя или null. */
export async function writeToDir(dir, blob, filename) {
  try {
    const fh = await dir.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return filename;
  } catch { return null; }
}

/* ===== MP3-кодирование в воркере ===== */

/** Кодирует AudioBuffer в MP3. onProgress(0..1). Не портит исходный буфер. */
export function encodeMP3(buffer, { bitrate = 192, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mp3-worker.js', import.meta.url), { type: 'module' });
    const chs = buffer.numberOfChannels;
    const left = new Float32Array(buffer.getChannelData(0));   // копия
    const right = chs > 1 ? new Float32Array(buffer.getChannelData(1)) : null;
    const transfer = [left.buffer, ...(right ? [right.buffer] : [])];
    worker.postMessage(
      { cmd: 'encode', channels: chs, sampleRate: buffer.sampleRate, bitrate, left, right },
      transfer
    );
    worker.onmessage = (e) => {
      const { type, progress, mp3, error } = e.data || {};
      if (type === 'progress') { onProgress?.(progress); return; }
      if (type === 'done') { worker.terminate(); resolve(new Blob([mp3], { type: 'audio/mpeg' })); return; }
      if (type === 'error') { worker.terminate(); reject(new Error(error)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Ошибка воркера')); };
  });
}

/* ===== Хранилище рингтонов (IndexedDB) ===== */

export async function saveRingtone({ title, artist, mp3, duration, sampleRate, bitrate }) {
  const rec = {
    id: newId(),
    title, artist: artist || '',
    duration: duration || 0,
    sampleRate: sampleRate || 0,
    bitrate: bitrate || 0,
    size: mp3.size,
    mp3,
    createdAt: Date.now(),
  };
  await dbPut('ringtones', rec);
  await ensurePersistent();
  return rec;
}

export async function listRingtones() {
  const list = (await dbGetAll('ringtones')) || [];
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

export async function deleteRingtone(id) { await dbDelete('ringtones', id); }

export async function updateRingtone(rec) { await dbPut('ringtones', rec); }

/* ===== Утилиты ===== */

export function sanitizeFilename(name) {
  let s = (name || '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ');
  if (!s) s = 'ringtone';
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}
