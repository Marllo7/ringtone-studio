// ui.js — модальные окна, шторки, меню, тосты, мелкие помощники

const modalRoot = document.getElementById('modal-root');
const toastsRoot = document.getElementById('toasts');

const stack = [];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function vibrate(ms = 10) {
  try { navigator.vibrate?.(ms); } catch { /* нет доступа */ }
}

/** Открывает модалку-шторку. content — Element или HTML-строка.
 *  opts: { locked: true — нельзя закрыть кликом по фону }
 *  Возвращает { el, close } */
export function modal(content, opts = {}) {
  const el = content instanceof Element ? content : h(content);
  const backdrop = h(`<div class="modal-backdrop"></div>`);
  const sheet = h(`<div class="sheet" role="dialog" aria-modal="true"></div>`);
  if (!el.querySelector('.sheet-close') && !opts.locked) {
    const title = el.querySelector('.sheet-title');
    if (title && !title.querySelector('.sheet-close')) {
      const btn = h(`<button class="sheet-close" aria-label="Закрыть">✕</button>`);
      title.appendChild(btn);
      btn.addEventListener('click', () => close());
    }
  }
  sheet.appendChild(el);
  backdrop.appendChild(sheet);
  modalRoot.appendChild(backdrop);

  function close() {
    const i = stack.findIndex(s => s.backdrop === backdrop);
    if (i >= 0) stack.splice(i, 1);
    backdrop.remove();
    opts.onClose?.();
  }
  if (!opts.locked) {
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close();
    });
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
  }
  const item = { backdrop, close };
  stack.push(item);
  return { el, close };
}

export function topModal() { return stack[stack.length - 1] || null; }

/** Меню-шторка со списком действий. items: [{icon, label, danger, onClick}] */
export function menuSheet(items, opts = {}) {
  const content = h(`<div>
      ${opts.title ? '<div class="sheet-title"><span class="grow"></span></div>' : ''}
      <div class="menu-list"></div>
    </div>`);
  if (opts.title) content.querySelector('.sheet-title .grow').textContent = opts.title;
  const box = content.querySelector('.menu-list');
  items.forEach(it => {
    const row = h(`<button class="menu-item ${it.danger ? 'danger' : ''}" type="button">
      <span class="mi-ico" aria-hidden="true"></span><span class="grow"></span></button>`);
    row.querySelector('.mi-ico').textContent = it.icon || '';
    row.querySelector('.grow').textContent = it.label;
    row.addEventListener('click', () => { m.close(); it.onClick?.(); });
    box.appendChild(row);
  });
  const m = modal(content);
  return m;
}

/** Подтверждение. Возвращает Promise<boolean> */
export function confirmDialog({ title = '', message = '', ok = 'ОК', cancel = 'Отмена', danger = false }) {
  return new Promise(resolve => {
    const el = h(`<div>
      <div class="sheet-title"><span class="grow"></span></div>
      ${title ? `<div style="font-weight:700;font-size:16.5px">${title}</div>` : ''}
      ${message ? `<div style="color:var(--muted);font-size:15px">${message}</div>` : ''}
      <div class="sheet-actions" style="flex-direction:row">
        <button class="btn ghost" data-act="no" style="flex:1">${cancel}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="yes" style="flex:1">${ok}</button>
      </div>
    </div>`);
    if (title) el.querySelector('.sheet-title .grow').textContent = title;
    let result = false;
    el.querySelector('[data-act=yes]').addEventListener('click', () => { result = true; m.close(); });
    el.querySelector('[data-act=no]').addEventListener('click', () => m.close());
    const m = modal(el, { onClose: () => resolve(result) });
  });
}

/** Диалог ввода текста. Возвращает Promise<string|null> */
export function promptDialog({ title = '', label = '', value = '', placeholder = '', ok = 'Сохранить' }) {
  return new Promise(resolve => {
    const el = h(`<div>
      <div class="sheet-title"><span class="grow"></span></div>
      <div class="field"><label></label><input type="text" spellcheck="false"></div>
      <div class="sheet-actions" style="flex-direction:row">
        <button class="btn ghost" data-act="no" style="flex:1">Отмена</button>
        <button class="btn primary" data-act="yes" style="flex:1">${ok}</button>
      </div>
    </div>`);
    el.querySelector('.sheet-title .grow').textContent = title;
    const inp = el.querySelector('input');
    el.querySelector('label').textContent = label;
    inp.value = value;
    inp.placeholder = placeholder;
    let result = null;
    const submit = () => {
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      result = v; m.close();
    };
    el.querySelector('[data-act=yes]').addEventListener('click', submit);
    el.querySelector('[data-act=no]').addEventListener('click', () => m.close());
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const m = modal(el, { onClose: () => resolve(result) });
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}

/** Тост. opts: { actionLabel, onAction, timeout }
 *  Возвращает { update(text), close() } */
export function toast(text, opts = {}) {
  const el = h(`<div class="toast"><div class="t-grow"></div></div>`);
  const label = el.querySelector('.t-grow');
  label.textContent = text;
  if (opts.actionLabel) {
    const a = h(`<button class="t-action" type="button"></button>`);
    a.textContent = opts.actionLabel;
    a.addEventListener('click', () => { opts.onAction?.(); close(); });
    el.appendChild(a);
  }
  toastsRoot.appendChild(el);
  let timer = null;
  const start = () => {
    clearTimeout(timer);
    if (opts.timeout !== 0) timer = setTimeout(close, opts.timeout ?? 3800);
  };
  function close() {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }
  start();
  return {
    update(t) { label.textContent = t; start(); },
    close,
  };
}
