// ringtones.js — вкладка «Рингтоны»: сохранённые файлы, проигрывание, установка

import { h, confirmDialog, promptDialog, toast, vibrate } from './ui.js';
import { listRingtones, deleteRingtone, updateRingtone, downloadBlob, shareFile } from './export.js';
import { fmtTime, fmtBytes, fmtDate } from './engine.js';

let view = null;
let items = [];
let audio = null;       // отдельный плеер для рингтонов
let playingId = null;
let playingUrl = null;
let cbShowHelp = null;
let cbGoToEditor = null;
let searchQ = '';

export function initRingtones({ showHelp, goToEditor }) {
  cbShowHelp = showHelp;
  cbGoToEditor = goToEditor;
  view = document.getElementById('view-ringtones');
  audio = new Audio();
  audio.addEventListener('ended', () => stopPlayback());
  render();
}

export function refresh() {
  render().then(() => {});
}

/* ================= Рендер ================= */

async function render() {
  items = await listRingtones();
  const totalSize = items.reduce((a, r) => a + (r.size || 0), 0);

  view.innerHTML = '';
  view.appendChild(h(`<div class="section-title">Мои рингтоны</div>`));

  if (items.length) {
    const head = h(`<div class="card-row">
        <div class="grow" style="font-size:14.5px"></div>
        <button class="btn small ghost">❓ Как поставить на звонок</button>
      </div>`);
    head.querySelector('.grow').textContent = `${items.length} шт. • ${fmtBytes(totalSize)} в приложении`;
    head.querySelector('button').addEventListener('click', () => cbShowHelp?.());
    view.appendChild(head);

    const search = h(`<div class="search-wrap"><input type="search" placeholder="Поиск рингтона…" aria-label="Поиск"></div>`);
    const input = search.querySelector('input');
    input.value = searchQ;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => { searchQ = input.value; await render(); const i2 = view.querySelector('input[type=search]'); if (i2) { i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); } }, 200);
    });
    view.appendChild(search);
  } else {
    const empty = h(`<div class="empty-state">
        <span class="e-ico">🔔</span>
        <div class="e-title">Здесь появятся ваши рингтоны</div>
        <p>Обрежьте любимую песню во вкладке «Обрезка» — и она ляжет сюда.
        Отсюда её можно скачать в телефон и поставить на звонок.</p>
        <button class="btn primary" data-act="make">✂️ Сделать рингтон</button>
      </div>`);
    empty.querySelector('[data-act=make]').addEventListener('click', () => cbGoToEditor?.());
    view.appendChild(empty);
    return;
  }

  const list = h(`<div class="track-list"></div>`);
  const q = searchQ.trim().toLowerCase();
  const visible = q ? items.filter(r => (r.title || '').toLowerCase().includes(q)) : items;

  if (!visible.length) {
    list.appendChild(h(`<div class="empty-state"><span class="e-ico">🔍</span><div class="e-title">Ничего не найдено</div></div>`));
  }

  visible.forEach(rec => list.appendChild(buildRow(rec)));
  view.appendChild(list);
}

function buildRow(rec) {
  const isPlaying = playingId === rec.id && !audio.paused;
  const row = h(`<div class="ring-row">
      <button class="ring-play ${isPlaying ? 'playing' : ''}" aria-label="Прослушать">
        ${isPlaying
          ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'}
      </button>
      <div class="t-main">
        <div class="t-title"></div>
        <div class="t-sub"></div>
      </div>
      <div class="ring-actions">
        <button class="icon-btn" data-act="dl" title="Скачать" aria-label="Скачать">⬇️</button>
        <button class="icon-btn" data-act="share" title="Поделиться" aria-label="Поделиться">↗️</button>
        <button class="icon-btn" data-act="rename" title="Переименовать" aria-label="Переименовать">✏️</button>
        <button class="icon-btn" data-act="del" title="Удалить" aria-label="Удалить">🗑️</button>
      </div>
    </div>`);
  row.querySelector('.t-title').textContent = rec.title || 'Рингтон';
  const sub = [
    rec.duration ? fmtTime(rec.duration, true) : '',
    fmtBytes(rec.size),
    fmtDate(rec.createdAt),
  ].filter(Boolean).join(' • ');
  row.querySelector('.t-sub').textContent = sub;

  row.querySelector('.ring-play').addEventListener('click', () => togglePlay(rec));
  row.querySelector('[data-act=dl]').addEventListener('click', () => {
    downloadBlob(rec.mp3, `${rec.title || 'ringtone'}.mp3`);
    toast('Файл — в «Загрузках» телефона', { actionLabel: 'Как поставить?', onAction: () => cbShowHelp?.() });
  });
  row.querySelector('[data-act=share]').addEventListener('click', async () => {
    await shareFile(rec.mp3, `${rec.title || 'ringtone'}.mp3`, rec.title);
  });
  row.querySelector('[data-act=rename]').addEventListener('click', async () => {
    const name = await promptDialog({ title: 'Переименовать рингтон', label: 'Название', value: rec.title });
    if (name) {
      rec.title = name;
      await updateRingtone(rec);
      refresh();
    }
  });
  row.querySelector('[data-act=del]').addEventListener('click', async () => {
    if (await confirmDialog({
      title: 'Удалить рингтон?',
      message: rec.title || '',
      ok: 'Удалить', danger: true,
    })) {
      if (playingId === rec.id) stopPlayback();
      await deleteRingtone(rec.id);
      vibrate(10);
      refresh();
    }
  });
  return row;
}

/* ================= Проигрывание ================= */

function togglePlay(rec) {
  if (playingId === rec.id) {
    if (audio.paused) audio.play().catch(() => {}); else stopPlayback();
    refresh();
    return;
  }
  stopPlayback();
  playingUrl = URL.createObjectURL(rec.mp3);
  audio.src = playingUrl;
  playingId = rec.id;
  audio.play().catch(() => {});
  vibrate(6);
  refresh();
}

function stopPlayback() {
  audio.pause();
  if (playingUrl) { URL.revokeObjectURL(playingUrl); playingUrl = null; }
  playingId = null;
  refresh();
}
