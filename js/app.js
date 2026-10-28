// app.js — сборка приложения: вкладки, помощь, установка, service worker

import { h, modal, toast } from './ui.js';
import { icon } from './icons.js';
import { unlockAudio } from './engine.js';
import { initLibrary, getTrack, openTrackPicker } from './library.js';
import { initPlayer, playQueue, togglePlay } from './player.js';
import { initEditor, openTrack as openEditorTrack, pickTrack as editorPick, hasTrack, stopPreview } from './editor.js';
import { initRingtones } from './ringtones.js';

/* ===== Вкладки ===== */

let currentTab = 'music';

function setTab(name) {
  if (currentTab === 'editor' && name !== 'editor') stopPreview();
  currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('view-music').classList.toggle('hidden', name !== 'music');
  document.getElementById('view-editor').classList.toggle('hidden', name !== 'editor');
  document.getElementById('view-ringtones').classList.toggle('hidden', name !== 'ringtones');
  document.getElementById('main').scrollTop = 0;
}

/* ===== Помощь: рингтон на iPhone (для Android это очевидно — не пишем) ===== */

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function showHelpModal() {
  const el = h(`<div>
    <div class="sheet-title"><span class="grow">Как сделать рингтон на iPhone</span></div>

    <span class="os-tag">iPhone</span>
    <div class="help-steps">
      <div class="help-step"><span class="hs-n">1</span><span>Нажмите <b>«Поделиться»</b> у рингтона и выберите <b>«Сохранить в Файлы»</b>.</span></div>
      <div class="help-step"><span class="hs-n">2</span><span>Откройте бесплатное приложение <b>GarageBand</b>, создайте проект и перетащите файл из «Файлов» на дорожку.</span></div>
      <div class="help-step"><span class="hs-n">3</span><span>Нажмите <b>«Отправить» → «Рингтон»</b>.</span></div>
    </div>
    <div class="help-note">Браузер на iPhone не может назначать рингтоны сам — это ограничение iOS. GarageBand — официальный способ Apple.</div>

    <button class="btn primary block" data-act="ok">Понятно</button>
  </div>`);
  el.querySelector('[data-act=ok]').addEventListener('click', () => el.__m.close());
  el.__m = modal(el);
}

/* ===== Первичный экран ===== */

function showOnboarding() {
  const el = h(`<div>
    <div class="sheet-title"><span class="grow">👋 Добро пожаловать!</span></div>
    <div class="help-step"><span class="hs-n">1</span><span><b>«Музыка»</b> — откройте папку с песнями (видна и SD-карта) или выберите файлы. Вся музыка появится в приложении.</span></div>
    <div class="help-step"><span class="hs-n">2</span><span><b>«Обрезка»</b> — выберите песню, выделите на волне лучший кусок или нажмите «Громкое место».</span></div>
    <div class="help-step"><span class="hs-n">3</span><span><b>«Создать рингтон»</b> — отрезок сохранится в приложение и в «Загрузки» телефона.</span></div>
    <button class="btn primary block" data-act="ok">Начать</button>
  </div>`);
  el.querySelector('[data-act=ok]').addEventListener('click', () => {
    localStorage.setItem('rs-onboarded', '1');
    el.__m.close();
  });
  el.__m = modal(el, { locked: true });
}

/* ===== Инициализация ===== */

function init() {
  // SVG-иконки из data-icon
  document.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon);
  });

  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => setTab(t.dataset.tab)));

  initLibrary({
    playQueue: (fids, i) => playQueue(fids, i),
    editTrack: (t) => { setTab('editor'); openEditorTrack(t); },
  });

  initPlayer({
    resolve: getTrack,
    onEditTrack: (t) => { setTab('editor'); openEditorTrack(t); },
  });

  initEditor({
    pickTrack: () => openTrackPicker({
      title: 'Выберите песню для обрезки',
      onPick: (t) => openEditorTrack(t),
    }),
  });

  initRingtones({
    goToEditor: () => { setTab('editor'); if (!hasTrack()) editorPick(); },
  });

  document.addEventListener('rs:goto', (e) => setTab(e.detail));

  // подсказка «?» — только на iPhone (для Android всё очевидно)
  const btnHelp = document.getElementById('btn-help');
  if (isIOS) btnHelp.classList.remove('hidden');
  btnHelp.addEventListener('click', showHelpModal);

  // разблокировка звука по первому касанию (iOS)
  const unlock = () => { unlockAudio(); document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock);

  // Space = play/pause (кроме редактора — там своя обработка)
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    if (document.querySelector('.modal-backdrop')) return;
    if (currentTab === 'editor') return;
    e.preventDefault();
    togglePlay();
  });

  // установка PWA
  const btnInstall = document.getElementById('btn-install');
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btnInstall.classList.remove('hidden');
  });
  btnInstall.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btnInstall.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => {
    btnInstall.classList.add('hidden');
    toast('Приложение установлено 🎉');
  });

  if (!localStorage.getItem('rs-onboarded')) showOnboarding();

  registerSW();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !isLocal) return;
  let reloading = false;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Обновление приложения готово', {
            actionLabel: 'Обновить',
            onAction: () => nw.postMessage({ type: 'SKIP_WAITING' }),
          });
        }
      });
    });
  }).catch(() => { /* без service worker приложение тоже работает */ });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

init();
