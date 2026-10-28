// library.js — музыкальная библиотека: папки, файлы, плейлисты, поиск, теги

import { h, modal, menuSheet, confirmDialog, promptDialog, toast } from './ui.js';
import { icon } from './icons.js';
import { dbGetAll, dbGet, dbPut, dbDelete, newId } from './db.js';
import { isAudioName, fidOf, trackInfoFromName, fmtTime, fmtBytes, extOf } from './engine.js';
import { readTags, parseM3U } from './id3.js';
import { downloadBlob } from './export.js';

const state = {
  tracks: new Map(),          // fid → track
  playlists: [],
  subTab: 'all',              // all | folders | playlists
  dir: [],                    // путь текущей папки (Папки)
  currentPlId: null,          // открытый плейлист
  currentAllFids: [],
  savedDirName: null,
  savedDirHandle: null,
  enrichQueue: [],
  enrichTotal: 0,
  enrichDone: 0,
  enrichActive: false,
};

let cbPlayQueue = null;
let cbEditTrack = null;
let view = null;
const els = {};
const coll = new Intl.Collator('ru', { sensitivity: 'base' });

/* ================= Инициализация ================= */

export function initLibrary({ playQueue, editTrack }) {
  cbPlayQueue = playQueue;
  cbEditTrack = editTrack;
  view = document.getElementById('view-music');
  buildMarkup();
  bindInputs();
  (async () => {
    state.playlists = (await dbGetAll('playlists')) || [];
    state.playlists.sort((a, b) => coll.compare(a.name, b.name));
    const rec = await dbGet('handles', 'musicDir');
    if (rec?.handle) {
      state.savedDirHandle = rec.handle;
      state.savedDirName = rec.name || rec.handle.name || 'папка';
    }
    renderSources();
    renderEverything();
    document.addEventListener('rs:playing', (e) => markPlaying(e.detail));
  })();
}

function buildMarkup() {
  view.innerHTML = `
    <div class="source-grid" id="sources"></div>
    <div class="tabs-sm" role="tablist">
      <button data-sub="all" class="active" type="button">Все треки</button>
      <button data-sub="folders" type="button">Папки</button>
      <button data-sub="playlists" type="button">Плейлисты</button>
    </div>
    <section id="panel-all"></section>
    <section id="panel-folders" class="hidden"></section>
    <section id="panel-playlists" class="hidden"></section>
    <!--
      Не задаём accept намеренно: на части Android-прошивок даже audio/* или
      список расширений запускает «Галерею» и скрывает аудио с SD-карты.
      Системное приложение «Файлы» покажет всё, а музыку мы отфильтруем сами
      в registerFile().
    -->
    <input type="file" id="in-files" class="hidden" multiple>
    <input type="file" id="in-folder" class="hidden" webkitdirectory directory>
    <input type="file" id="in-m3u" class="hidden" accept=".m3u,.m3u8,text/plain">
  `;
  els.panelAll = view.querySelector('#panel-all');
  els.panelFolders = view.querySelector('#panel-folders');
  els.panelPlaylists = view.querySelector('#panel-playlists');
  els.sources = view.querySelector('#sources');
  els.inFiles = view.querySelector('#in-files');
  els.inFolder = view.querySelector('#in-folder');
  els.inM3u = view.querySelector('#in-m3u');
  view.querySelectorAll('[data-sub]').forEach(b =>
    b.addEventListener('click', () => showSubTab(b.dataset.sub)));
}

function bindInputs() {
  els.inFiles.addEventListener('change', () => {
    addFiles(els.inFiles.files);
    els.inFiles.value = '';
  });
  els.inFolder.addEventListener('change', () => {
    addFiles(els.inFolder.files);
    els.inFolder.value = '';
  });
  els.inM3u.addEventListener('change', async () => {
    const f = els.inM3u.files[0];
    if (f) await importM3U(f);
    els.inM3u.value = '';
  });
}

const hasDirPicker = () => 'showDirectoryPicker' in window;
const supportsDirAttr = () => {
  const i = document.createElement('input');
  return 'webkitdirectory' in i;
};

function renderSources() {
  els.sources.innerHTML = '';
  const dirBtn = h(`<button class="source-btn" type="button">
      <span class="s-ico" aria-hidden="true">${icon('folderOpen', 28)}</span>
      <span class="s-name">${hasDirPicker() || supportsDirAttr() ? 'Открыть папку' : 'Выбрать файлы'}</span>
      <span class="s-sub">с музыкой — сразу все песни</span>
    </button>`);
  dirBtn.addEventListener('click', openDirPicker);
  const fileBtn = h(`<button class="source-btn" type="button">
      <span class="s-ico mp-ico" aria-hidden="true">${icon('music', 28)}</span>
      <span class="s-name">Выбрать файлы</span>
      <span class="s-sub">MP3, M4A, WAV — из приложения «Файлы»</span>
    </button>`);
  fileBtn.addEventListener('click', () => els.inFiles.click());
  els.sources.append(dirBtn, fileBtn);
  if (state.savedDirName && hasDirPicker()) {
    const r = h(`<div class="resume-line" style="grid-column:1/-1">
        <span aria-hidden="true">${icon('history', 18)}</span>
        <span class="grow">Недавняя папка: «${escapeHtml(state.savedDirName)}»</span>
        <button class="btn small primary" type="button">Открыть</button>
      </div>`);
    r.querySelector('button').addEventListener('click', resumeSavedDir);
    els.sources.appendChild(r);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= Добавление музыки ================= */

function registerFile(file, path) {
  if (!isAudioName(file.name)) return null;
  const fid = fidOf(file);
  if (state.tracks.has(fid)) return null;
  const parsed = trackInfoFromName(file.name);
  const track = {
    fid, file, name: file.name,
    title: parsed.title, artist: parsed.artist,
    path: path || '', addedAt: Date.now(), duration: undefined,
  };
  state.tracks.set(fid, track);
  return track;
}

function addFiles(fileList) {
  if (!fileList || !fileList.length) {
    toast('Файлы не выбраны. Откройте приложение «Файлы», а не «Галерею».', { timeout: 3500 });
    return;
  }
  const added = [];
  for (const f of fileList) {
    const rel = f.webkitRelativePath || '';
    const path = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const t = registerFile(f, path);
    if (t) added.push(t);
  }
  afterAdd(added, fileList.length);
}

function afterAdd(added, attempted) {
  if (added.length) {
    enqueueEnrich(added);
    renderEverything(true);
    toast(`Добавлено треков: ${added.length}`, { timeout: 2500 });
  } else if (attempted) {
    toast('Аудиофайлы не найдены. Выберите MP3, M4A или WAV в приложении «Файлы».', { timeout: 4000 });
  }
}

async function openDirPicker() {
  if (hasDirPicker()) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      const t = toast('Читаем папку…', { timeout: 0 });
      const added = await walkDir(dir, '');
      const name = dir.name || 'папка';
      state.savedDirHandle = dir;
      state.savedDirName = name;
      await dbPut('handles', { id: 'musicDir', name, handle: dir });
      t.close();
      afterAdd(added, added.length + 1);
      renderSources();
    } catch (e) {
      if (e?.name !== 'AbortError') toast('Не удалось открыть папку');
    }
  } else if (supportsDirAttr()) {
    els.inFolder.click();
  } else {
    els.inFiles.click();
  }
}

async function walkDir(handle, prefix) {
  const added = [];
  try {
    for await (const entry of handle.values()) {
      if (entry.kind === 'file') {
        try {
          const f = await entry.getFile();
          const t = registerFile(f, prefix);
          if (t) added.push(t);
        } catch { /* файл недоступен */ }
      } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
        const sub = prefix ? `${prefix}/${entry.name}` : entry.name;
        added.push(...await walkDir(entry, sub));
      }
    }
  } catch { /* нет прав чтения подпапки */ }
  return added;
}

async function resumeSavedDir() {
  const handle = state.savedDirHandle;
  if (!handle) return;
  try {
    let perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') { toast('Доступ к папке не выдан'); return; }
    const t = toast('Читаем папку…', { timeout: 0 });
    const added = await walkDir(handle, '');
    t.close();
    afterAdd(added, added.length + 1);
  } catch {
    toast('Не удалось открыть папку');
  }
}

/* ================= Обогащение данных (теги + длительность) ================= */

function enqueueEnrich(tracks) {
  state.enrichQueue.push(...tracks);
  state.enrichTotal += tracks.length;
  updateEnrichStatus();
  pumpEnrich();
}

async function pumpEnrich() {
  if (state.enrichActive) return;
  state.enrichActive = true;
  while (state.enrichQueue.length) {
    const track = state.enrichQueue.shift();
    try {
      const tags = await readTags(track.file, { withCover: false });
      if (tags.title) track.title = tags.title;
      if (tags.artist) track.artist = tags.artist;
      if (tags.album) track.album = tags.album;
      track.duration = await probeDuration(track.file);
    } catch { /* файл нечитается — оставляем как есть */ }
    state.enrichDone++;
    updateRows(track.fid);
    updateEnrichStatus();
    await new Promise(r => setTimeout(r, 0));
  }
  state.enrichActive = false;
  state.enrichTotal = 0;
  state.enrichDone = 0;
  setTimeout(updateEnrichStatus, 400);
}

function updateEnrichStatus() {
  const el = view.querySelector('.enrich-line');
  if (!el) return;
  if (state.enrichTotal > 0 && state.enrichDone < state.enrichTotal) {
    el.textContent = `Читаем названия и длительности: ${state.enrichDone} из ${state.enrichTotal}…`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function probeDuration(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      clearTimeout(tid);
      a.onloadedmetadata = a.onerror = null;
      a.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(d);
    };
    const tid = setTimeout(() => finish(undefined), 4500);
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(isFinite(a.duration) && a.duration > 0 ? a.duration : undefined);
    a.onerror = () => finish(undefined);
    a.src = url;
  });
}

/* ================= Общий рендер ================= */

function renderEverything(refreshSources) {
  if (refreshSources) renderSources();
  renderAll();
  renderFolders();
  renderPlaylists();
}

function showSubTab(name) {
  state.subTab = name;
  view.querySelectorAll('[data-sub]').forEach(b => b.classList.toggle('active', b.dataset.sub === name));
  els.panelAll.classList.toggle('hidden', name !== 'all');
  els.panelFolders.classList.toggle('hidden', name !== 'folders');
  els.panelPlaylists.classList.toggle('hidden', name !== 'playlists');
}

/* ================= Вкладка «Все» ================= */

function getSortFn() {
  switch (els.sortSel?.value || 'title') {
    case 'artist': return (a, b) => coll.compare(a.artist || 'яячч', b.artist || 'яячч') || coll.compare(a.title, b.title);
    case 'name': return (a, b) => coll.compare(a.name, b.name);
    case 'added': return (a, b) => b.addedAt - a.addedAt;
    default: return (a, b) => coll.compare(a.title, b.title);
  }
}

function searchFilter(tracks, q) {
  if (!q) return tracks;
  const nq = q.trim().toLowerCase();
  if (!nq) return tracks;
  return tracks.filter(t =>
    t.title.toLowerCase().includes(nq) ||
    t.artist.toLowerCase().includes(nq) ||
    t.name.toLowerCase().includes(nq));
}

function renderAll() {
  const q = els.searchInput?.value || '';
  const sorted = [...state.tracks.values()].sort(getSortFn());
  const visible = searchFilter(sorted, q);
  state.currentAllFids = visible.map(t => t.fid);

  els.panelAll.innerHTML = '';
  const toolbar = h(`<div class="list-toolbar">
      <div class="search-wrap"><input type="search" placeholder="Поиск: название или исполнитель…" aria-label="Поиск"></div>
      <select aria-label="Сортировка">
        <option value="title">По названию</option>
        <option value="artist">По исполнителю</option>
        <option value="name">По файлу</option>
        <option value="added">Сначала новые</option>
      </select>
    </div>`);
  els.searchInput = toolbar.querySelector('input');
  els.sortSel = toolbar.querySelector('select');
  els.sortSel.value = state.sortMode || 'title';
  els.searchInput.value = q;
  els.sortSel.addEventListener('change', () => { state.sortMode = els.sortSel.value; renderAll(); });
  let searchTimer = null;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderAll, 180);
  });
  els.panelAll.appendChild(toolbar);

  const stats = h(`<div>
      <div class="count-line"></div>
      <div class="enrich-line" hidden></div>
    </div>`);
  els.panelAll.appendChild(stats);
  stats.querySelector('.count-line').textContent = visible.length
    ? (q ? `Найдено: ${visible.length}` : `Треков: ${visible.length}`)
    : '';
  updateEnrichStatus();

  if (!state.tracks.size) {
    els.panelAll.appendChild(emptyState('library', 'Библиотека пуста',
      'Нажмите «Открыть папку» и выберите папку с музыкой на телефоне или карте памяти. Все треки появятся здесь.'));
    return;
  }
  if (!visible.length) {
    els.panelAll.appendChild(emptyState('search', 'Ничего не найдено', 'Попробуйте изменить запрос.'));
    return;
  }
  renderBatchedList(els.panelAll, visible, state.currentAllFids);
}

function emptyState(icoName, title, text) {
  return h(`<div class="empty-state"><span class="e-ico">${icon(icoName, 56)}</span>
    <div class="e-title">${escapeHtml(title)}</div><p>${text}</p></div>`);
}

/** Список с догрузкой при прокрутке (пачками по 120) */
function renderBatchedList(container, items, contextFids) {
  const list = h(`<div class="track-list"></div>`);
  const moreBtn = h(`<button class="btn ghost block append-more" type="button">Показать ещё</button>`);
  container.appendChild(list);
  let rendered = 0;
  const BATCH = 120;
  const renderNext = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(items.length, rendered + BATCH);
    for (let i = rendered; i < end; i++) {
      const idx = contextFids ? contextFids.indexOf(items[i].fid) : i;
      frag.appendChild(buildTrackRow(items[i], idx, contextFids ? () => [...contextFids] : null));
    }
    rendered = end;
    list.appendChild(frag);
    const hasMore = rendered < items.length;
    moreBtn.classList.toggle('hidden', !hasMore);
    if (hasMore && !moreBtn.parentNode) container.appendChild(moreBtn);
  };
  moreBtn.addEventListener('click', renderNext);
  renderNext();
  // автозагрузка при приближении к концу
  const sentinel = h(`<div class="append-sentinel"></div>`);
  container.appendChild(sentinel);
  const io = new IntersectionObserver((ents) => {
    if (ents[0].isIntersecting && rendered < items.length) renderNext();
    if (rendered >= items.length) io.disconnect();
  }, { root: document.getElementById('main'), rootMargin: '300px' });
  io.observe(sentinel);
}

function buildTrackRow(track, index, contextGetter) {
  const row = h(`<div class="track-row" data-fid="${escapeHtml(track.fid)}">
      <div class="t-art" aria-hidden="true">${icon('music')}</div>
      <div class="t-main"><div class="t-title"></div><div class="t-sub"></div></div>
      <div class="t-dur">—</div>
      <button class="t-menu" aria-label="Меню">⋮</button>
    </div>`);
  fillTrackRow(row, track);
  row.addEventListener('click', () => {
    const ctx = contextGetter ? contextGetter() : [track.fid];
    cbPlayQueue(ctx, Math.max(0, index));
  });
  row.querySelector('.t-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    openTrackMenu(track, contextGetter, index);
  });
  return row;
}

function fillTrackRow(row, track) {
  row.querySelector('.t-title').textContent = track.title || track.name;
  const sub = [];
  if (track.artist) sub.push(track.artist);
  const folder = track.path ? track.path.split('/').pop() : '';
  if (folder) sub.push(folder);
  const subEl = row.querySelector('.t-sub');
  subEl.textContent = sub.join(' • ');
  row.querySelector('.t-dur').textContent = track.duration ? fmtTime(track.duration) : '—';
}

function updateRows(fid) {
  const track = state.tracks.get(fid);
  if (!track) return;
  document.querySelectorAll(`[data-fid="${cssEscape(fid)}"]`).forEach(row => {
    if (row.classList.contains('track-row')) fillTrackRow(row, track);
  });
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

let playingFid = null;
function markPlaying(fid) {
  playingFid = fid;
  document.querySelectorAll('.track-row.playing').forEach(r => r.classList.remove('playing'));
  if (fid) document.querySelectorAll(`[data-fid="${cssEscape(fid)}"]`).forEach(r => r.classList.add('playing'));
}

function openTrackMenu(track, contextGetter, index) {
  menuSheet([
    { icon: icon('play'), label: 'Воспроизвести', onClick: () => cbPlayQueue(contextGetter ? contextGetter() : [track.fid], Math.max(0, index)) },
    { icon: icon('cut'), label: 'Сделать рингтон', onClick: () => cbEditTrack(track) },
    { icon: icon('add'), label: 'Добавить в плейлист…', onClick: () => addToPlaylistDialog(track) },
    { icon: icon('info'), label: 'Свойства', onClick: () => showTrackInfo(track) },
  ], { title: track.title || track.name });
}

function showTrackInfo(track) {
  const rows = [
    ['Название', track.title || '—'],
    ['Исполнитель', track.artist || '—'],
    ['Альбом', track.album || '—'],
    ['Файл', track.name],
    ['Папка', track.path || '—'],
    ['Формат', (extOf(track.name) || '—').toUpperCase()],
    ['Размер', fmtBytes(track.file.size)],
    ['Длительность', track.duration ? fmtTime(track.duration) : '—'],
  ];
  const el = h(`<div>
      <div class="sheet-title"><span class="grow">Свойства</span></div>
      ${rows.map(r => `<div style="display:flex;gap:10px;justify-content:space-between;font-size:14.5px;padding:6px 2px;border-bottom:1px solid var(--border)">
        <span style="color:var(--muted);white-space:nowrap">${r[0]}</span>
        <span style="text-align:right;word-break:break-all;font-weight:600">${escapeHtml(r[1])}</span>
      </div>`).join('')}
      <button class="btn primary block" data-act="ring">${icon('cut', 18)} Сделать рингтон</button>
    </div>`);
  el.querySelector('[data-act=ring]').addEventListener('click', () => { el.__m?.close(); cbEditTrack(track); });
  el.__m = modal(el);
}

/* ================= Вкладка «Папки» ================= */

function buildTree() {
  const root = { name: '', path: '', dirs: new Map(), fids: [] };
  const loose = [];
  for (const t of state.tracks.values()) {
    if (!t.path) { loose.push(t.fid); continue; }
    const parts = t.path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path, dirs: new Map(), fids: [] });
      node = node.dirs.get(p);
    });
    node.fids.push(t.fid);
  }
  return { root, loose };
}

function countAll(node) {
  let n = node.fids.length;
  for (const d of node.dirs.values()) n += countAll(d);
  return n;
}

function renderFolders() {
  const p = els.panelFolders;
  p.innerHTML = '';
  if (!state.tracks.size) {
    p.appendChild(emptyState('folder', 'Папок пока нет',
      'Откройте папку с музыкой — здесь появятся её папки и альбомы.'));
    return;
  }
  const { root, loose } = buildTree();
  const node = state.dir.length
    ? getNodeByPath(root, state.dir)
    : root;
  if (!node) { state.dir = []; renderFolders(); return; }

  // Хлебные крошки
  if (state.dir.length) {
    const cr = h(`<div class="breadcrumb"></div>`);
    const rootBtn = h(`<button type="button">${icon('folder', 16)} Начало</button>`);
    rootBtn.addEventListener('click', () => { state.dir = []; renderFolders(); });
    cr.append(rootBtn);
    state.dir.forEach((seg, i) => {
      cr.append(h(`<span class="sep">›</span>`));
      const disp = seg === '\u0000loose' ? 'Выбранные файлы' : seg;
      if (i < state.dir.length - 1) {
        const b = h(`<button type="button"></button>`);
        b.textContent = disp;
        b.addEventListener('click', () => { state.dir = state.dir.slice(0, i + 1); renderFolders(); });
        cr.append(b);
      } else {
        const cur = h(`<span class="cur"></span>`);
        cur.textContent = disp;
        cr.append(cur);
      }
    });
    p.appendChild(cr);
  }

  const list = h(`<div class="track-list" style="margin-top:4px"></div>`);

  // Подпапки
  const dirs = [...node.dirs.values()].sort((a, b) => coll.compare(a.name, b.name));
  for (const d of dirs) {
    const total = countAll(d);
    const row = h(`<div class="folder-row">
        <span class="f-ico" aria-hidden="true">${icon('folder')}</span>
        <span class="f-name">${escapeHtml(d.name)}</span>
        <span class="f-count">${total}</span>
      </div>`);
    row.addEventListener('click', () => { state.dir.push(d.name); renderFolders(); });
    list.appendChild(row);
  }

  // Файлы без папки (на верхнем уровне)
  if (!state.dir.length && loose.length) {
    const row = h(`<div class="folder-row">
        <span class="f-ico" aria-hidden="true">${icon('music')}</span>
        <span class="f-name">Выбранные отдельно файлы</span>
        <span class="f-count">${loose.length}</span>
      </div>`);
    row.addEventListener('click', () => { state.dir = ['\u0000loose']; renderFolders(); });
    list.appendChild(row);
  }

  // Треки этой папки
  let fidsHere = node === root ? [] : node.fids.slice();
  if (state.dir[0] === '\u0000loose') fidsHere = loose.slice();

  if (fidsHere.length) {
    const head = h(`<div class="folder-row" style="background:var(--surface-2)">
        <span class="f-ico" aria-hidden="true">${icon('headset')}</span>
        <span class="f-name">Треков в папке: ${fidsHere.length}</span>
        <button class="play-mini" aria-label="Слушать папку">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>`);
    head.querySelector('.play-mini').addEventListener('click', (e) => {
      e.stopPropagation();
      cbPlayQueue(fidsHere.slice(), 0);
    });
    list.appendChild(head);
    fidsHere.forEach((fid, i) => {
      const t = state.tracks.get(fid);
      if (t) list.appendChild(buildTrackRow(t, i, () => fidsHere.slice()));
    });
  } else if (state.dir.length && !dirs.length) {
    list.appendChild(emptyState('music', 'Здесь только подпапки', 'Откройте подпапку, чтобы увидеть треки.'));
  }

  p.appendChild(list);
}

function getNodeByPath(root, segs) {
  let node = root;
  for (const s of segs) {
    if (s === '\u0000loose') return { name: 'files', path: '', dirs: new Map(), fids: [] };
    if (!node.dirs.has(s)) return null;
    node = node.dirs.get(s);
  }
  return node;
}

/* ================= Плейлисты ================= */

async function savePlaylistsOrder() {
  state.playlists.sort((a, b) => coll.compare(a.name, b.name));
}

function renderPlaylists() {
  const p = els.panelPlaylists;
  p.innerHTML = '';
  if (state.currentPlId) { renderPlaylistDetail(p); return; }

  // Кнопки
  const actions = h(`<div class="pl-actions">
      <button class="btn" type="button">${icon('add', 18)} Новый плейлист</button>
      <button class="btn ghost" type="button">${icon('upload', 18)} Импорт M3U</button>
    </div>`);
  actions.children[0].addEventListener('click', createPlaylistDialog);
  actions.children[1].addEventListener('click', () => els.inM3u.click());
  p.appendChild(actions);

  if (!state.playlists.length) {
    p.appendChild(emptyState('queue', 'Плейлисты',
      'Создайте свой плейлист — например «Любимые песни» — и собирайте в него музыку. Плейлисты хранятся в приложении.'));
    return;
  }

  const list = h(`<div class="track-list"></div>`);
  for (const pl of state.playlists) {
    const known = pl.fids.filter(f => state.tracks.has(f)).length;
    const row = h(`<div class="playlist-row">
        <span class="f-ico" aria-hidden="true">${icon('queue')}</span>
        <span class="f-name">${escapeHtml(pl.name)}</span>
        <span class="f-count">${known}${known !== pl.fids.length ? ` (+${pl.fids.length - known} скрыто)` : ''}</span>
        ${known ? `<button class="play-mini" aria-label="Слушать">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>` : ''}
        <button class="t-menu" aria-label="Меню">⋮</button>
      </div>`);
    row.addEventListener('click', () => { state.currentPlId = pl.id; renderPlaylists(); });
    const playBtn = row.querySelector('.play-mini');
    if (playBtn) playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fids = pl.fids.filter(f => state.tracks.has(f));
      if (fids.length) cbPlayQueue(fids, 0);
      else toast('В плейлисте нет доступных треков — откройте папку с музыкой');
    });
    row.querySelector('.t-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      playlistMenu(pl);
    });
    list.appendChild(row);
  }
  p.appendChild(list);
}

function playlistMenu(pl) {
  menuSheet([
    { icon: icon('play'), label: 'Слушать', onClick: () => {
        const fids = pl.fids.filter(f => state.tracks.has(f));
        if (fids.length) cbPlayQueue(fids, 0);
        else toast('Сначала откройте папку с музыкой');
      } },
    { icon: icon('edit'), label: 'Переименовать', onClick: async () => {
        const name = await promptDialog({ title: 'Плейлист', label: 'Название', value: pl.name });
        if (name) { pl.name = name; pl.updatedAt = Date.now(); await dbPut('playlists', pl); await savePlaylistsOrder(); renderPlaylists(); }
      } },
    { icon: icon('download'), label: 'Экспорт в M3U', onClick: () => exportM3U(pl) },
    { icon: icon('remove'), label: 'Удалить плейлист', danger: true, onClick: async () => {
        if (await confirmDialog({ title: `Удалить «${pl.name}»?`, message: 'Плейлист удалится, файлы музыки останутся.', ok: 'Удалить', danger: true })) {
          await dbDelete('playlists', pl.id);
          state.playlists = state.playlists.filter(x => x.id !== pl.id);
          renderPlaylists();
        }
      } },
  ], { title: pl.name });
}

async function createPlaylistDialog() {
  const name = await promptDialog({ title: 'Новый плейлист', label: 'Название плейлиста', placeholder: 'Например: Любимые песни' });
  if (!name) return;
  const pl = { id: newId(), name, fids: [], createdAt: Date.now(), updatedAt: Date.now() };
  state.playlists.push(pl);
  await dbPut('playlists', pl);
  await savePlaylistsOrder();
  renderPlaylists();
  toast(`Плейлист «${name}» создан`);
}

function renderPlaylistDetail(p) {
  const pl = state.playlists.find(x => x.id === state.currentPlId);
  if (!pl) { state.currentPlId = null; renderPlaylists(); return; }

  const head = h(`<div class="playlist-head">
      <button class="icon-btn" aria-label="Назад" data-act="back">${icon('back')}</button>
      <h2>${escapeHtml(pl.name)}</h2>
    </div>`);
  head.querySelector('[data-act=back]').addEventListener('click', () => { state.currentPlId = null; renderPlaylists(); });
  p.appendChild(head);

  const known = pl.fids.filter(f => state.tracks.has(f));
  const actions = h(`<div class="pl-actions">
      <button class="btn" type="button">${icon('add', 18)} Добавить музыку</button>
      <button class="btn ghost primary-text ${known.length ? '' : 'hidden'}" type="button">${icon('headset', 18)} Слушать</button>
    </div>`);
  actions.children[0].addEventListener('click', () => {
    openTrackPickerMulti({
      title: 'Добавить в плейлист',
      exclude: new Set(pl.fids),
      onPick: async (fids) => {
        pl.fids.push(...fids);
        pl.updatedAt = Date.now();
        await dbPut('playlists', pl);
        renderPlaylists();
        toast(`Добавлено: ${fids.length}`);
      },
    });
  });
  const playBtn = actions.children[1];
  playBtn.addEventListener('click', () => { if (known.length) cbPlayQueue(known.slice(), 0); });
  playBtn.classList.remove('primary-text');
  if (known.length) playBtn.classList.add('primary');
  p.appendChild(actions);

  if (!pl.fids.length) {
    p.appendChild(emptyState('add', 'Плейлист пуст', 'Нажмите «Добавить музыку» и выберите треки из библиотеки.'));
    return;
  }

  const list = h(`<div class="track-list"></div>`);
  let idx = 0;
  for (const fid of pl.fids) {
    const t = state.tracks.get(fid);
    if (t) {
      const i = idx++;
      list.appendChild(buildTrackRow(t, i, () => known.slice()));
    } else {
      const miss = h(`<div class="track-row" style="opacity:.55">
          <div class="t-art" aria-hidden="true">${icon('music')}</div>
          <div class="t-main"><div class="t-title">Файл пока не открыт</div>
          <div class="t-sub">Откройте папку с музыкой — трек вернётся</div></div>
          <button class="icon-btn" aria-label="Убрать">${icon('remove')}</button>
        </div>`);
      miss.querySelector('button').addEventListener('click', async () => {
        pl.fids = pl.fids.filter(f => f !== fid);
        pl.updatedAt = Date.now();
        await dbPut('playlists', pl);
        renderPlaylists();
      });
      list.appendChild(miss);
    }
  }
  p.appendChild(list);
}

async function addToPlaylistDialog(track) {
  const items = state.playlists.map(pl => ({
    icon: icon('queue'), label: pl.name, onClick: async () => {
      if (pl.fids.includes(track.fid)) { toast('Уже в этом плейлисте'); return; }
      pl.fids.push(track.fid);
      pl.updatedAt = Date.now();
      await dbPut('playlists', pl);
      toast(`«${track.title || track.name}» → «${pl.name}»`);
    },
  }));
  items.push({ icon: icon('add'), label: 'Новый плейлист…', onClick: async () => {
    const name = await promptDialog({ title: 'Новый плейлист', label: 'Название', placeholder: 'Например: Любимые песни' });
    if (!name) return;
    const pl = { id: newId(), name, fids: [track.fid], createdAt: Date.now(), updatedAt: Date.now() };
    state.playlists.push(pl);
    await dbPut('playlists', pl);
    await savePlaylistsOrder();
    toast(`Плейлист «${name}» создан`);
  }});
  menuSheet(items, { title: 'Куда добавить?' });
}

async function importM3U(file) {
  const text = await file.text();
  const entries = parseM3U(text);
  if (!entries.length) { toast('В файле нет треков'); return; }
  const byName = new Map();
  for (const t of state.tracks.values()) {
    byName.set(t.name.toLowerCase(), t);
    byName.set(t.name.toLowerCase().replace(/\.[a-z0-9]+$/, ''), t);
  }
  const matched = new Set();
  for (const e of entries) {
    const key = (e.name || '').toLowerCase();
    if (!key) continue;
    const keyNoExt = key.replace(/\.[a-z0-9]+$/, '');
    const tr = byName.get(key) || byName.get(keyNoExt);
    for (const [k, t] of byName) {
      if (!tr && (k.startsWith(key) || key.startsWith(k))) { matched.add(t.fid); break; }
    }
    if (tr) matched.add(tr.fid);
  }
  const pl = {
    id: newId(),
    name: file.name.replace(/\.(m3u8?|pls)$/i, ''),
    fids: [...matched],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.playlists.push(pl);
  await dbPut('playlists', pl);
  await savePlaylistsOrder();
  renderPlaylists();
  toast(`Импортировано: найдено ${pl.fids.length} из ${entries.length} треков`);
}

function exportM3U(pl) {
  let text = '#EXTM3U\n';
  for (const fid of pl.fids) {
    const t = state.tracks.get(fid);
    if (!t) continue;
    const name = t.artist ? `${t.artist} - ${t.title}` : (t.title || t.name);
    text += `#EXTINF:${Math.round(t.duration || -1)},${name}\n${t.name}\n`;
  }
  downloadBlob(new Blob([text], { type: 'audio/x-mpegurl' }), `${pl.name}.m3u8`);
  toast('Плейлист сохранён в загрузки');
}

/* ================= Пикеры треков (для редактора и плейлистов) ================= */

export function getTrack(fid) { return state.tracks.get(fid); }
export function listTracks() { return [...state.tracks.values()]; }

export function openTrackPicker({ title = 'Выберите трек', onPick }) {
  const tracks = [...state.tracks.values()].sort((a, b) => coll.compare(a.title, b.title));
  const el = h(`<div>
      <div class="sheet-title"><span class="grow">${escapeHtml(title)}</span></div>
      <div class="search-wrap"><input type="search" placeholder="Поиск…" aria-label="Поиск"></div>
      <div class="track-list pt-list" style="max-height:56vh;overflow-y:auto"></div>
    </div>`);
  const input = el.querySelector('input');
  const box = el.querySelector('.pt-list');
  if (!tracks.length) {
    box.appendChild(emptyState('folder', 'Сначала добавьте музыку', 'Вернитесь во вкладку «Музыка» и откройте папку с песнями.'));
  }
  const m = modal(el);
  const doRender = () => {
    box.innerHTML = '';
    const vis = searchFilter(tracks, input.value);
    if (!vis.length) {
      box.appendChild(emptyState('search', 'Ничего не найдено', ''));
      return;
    }
    vis.forEach(t => {
      const row = h(`<div class="track-row">
          <div class="t-art" aria-hidden="true">${icon('music')}</div>
          <div class="t-main"><div class="t-title"></div><div class="t-sub"></div></div>
          <div class="t-dur"></div>
        </div>`);
      fillTrackRow(row, t);
      row.addEventListener('click', () => { m.close(); onPick(t); });
      box.appendChild(row);
    });
  };
  input.addEventListener('input', doRender);
  doRender();
}

export function openTrackPickerMulti({ title = 'Выберите треки', exclude = new Set(), onPick }) {
  const tracks = [...state.tracks.values()].sort((a, b) => coll.compare(a.title, b.title))
    .filter(t => !exclude.has(t.fid));
  const picked = new Set();
  const el = h(`<div>
      <div class="sheet-title"><span class="grow">${escapeHtml(title)}</span></div>
      <div class="search-wrap"><input type="search" placeholder="Поиск…" aria-label="Поиск"></div>
      <div class="track-list pt-list" style="max-height:52vh;overflow-y:auto"></div>
      <button class="btn primary block sticky-add" data-act="add" disabled>Добавить</button>
    </div>`);
  const input = el.querySelector('input');
  const box = el.querySelector('.pt-list');
  const addBtn = el.querySelector('[data-act=add]');
  const m = modal(el);
  const updateBtn = () => {
    addBtn.disabled = picked.size === 0;
    addBtn.textContent = picked.size ? `Добавить (${picked.size})` : 'Добавить';
  };
  const doRender = () => {
    box.innerHTML = '';
    const vis = searchFilter(tracks, input.value);
    if (!vis.length) {
      box.appendChild(emptyState('add', tracks.length ? 'Ничего не найдено' : 'Нет доступных треков',
        tracks.length ? '' : 'Сначала откройте папку с музыкой во вкладке «Музыка».'));
      return;
    }
    vis.forEach(t => {
      const row = h(`<div class="track-row ${picked.has(t.fid) ? 'picked' : ''}" data-pid="${escapeHtml(t.fid)}">
          <div class="t-check">${picked.has(t.fid) ? '✓' : ''}</div>
          <div class="t-main"><div class="t-title"></div><div class="t-sub"></div></div>
          <div class="t-dur"></div>
        </div>`);
      fillTrackRow(row, t);
      row.addEventListener('click', () => {
        if (picked.has(t.fid)) { picked.delete(t.fid); row.classList.remove('picked'); row.querySelector('.t-check').textContent = ''; }
        else { picked.add(t.fid); row.classList.add('picked'); row.querySelector('.t-check').textContent = '✓'; }
        updateBtn();
      });
      box.appendChild(row);
    });
  };
  input.addEventListener('input', doRender);
  addBtn.addEventListener('click', () => { m.close(); onPick([...picked]); });
  doRender();
  updateBtn();
}
