// id3.js — минимальный парсер тегов ID3v2 (название, исполнитель, альбом, год, обложка)

/**
 * Читает теги из файла.
 * opts.withCover — захватить обложку (APIC/PIC), возвращает Blob.
 */
export async function readTags(file, { withCover = false } = {}) {
  try {
    const headBuf = await file.slice(0, 10).arrayBuffer();
    const head = new Uint8Array(headBuf);
    if (head.length < 10) return {};
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {}; // "ID3"
    const major = head[3];
    if (major < 2 || major > 4) return {};
    const flags = head[5];
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    const readSize = Math.min(file.size, 10 + Math.min(size, 2 * 1024 * 1024));
    const buf = await file.slice(0, readSize).arrayBuffer();
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    return parseId3(dv, u8, major, flags, { withCover });
  } catch {
    return {};
  }
}

function ascii(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const synchsafe = (dv, off) => ((dv.getUint8(off) & 0x7f) << 21) | ((dv.getUint8(off + 1) & 0x7f) << 14) | ((dv.getUint8(off + 2) & 0x7f) << 7) | (dv.getUint8(off + 3) & 0x7f);
const u32 = (dv, off) => dv.getUint32(off);

function decodeText(bytes) {
  if (!bytes.length) return '';
  const enc = bytes[0];
  const rest = bytes.subarray(1);
  try {
    if (enc === 0) return trimNull(new TextDecoder('windows-1252').decode(rest));
    if (enc === 1) {
      if (rest[0] === 0xff && rest[1] === 0xfe) return trimNull(new TextDecoder('utf-16le').decode(rest.subarray(2)));
      return trimNull(new TextDecoder('utf-16').decode(rest)); // BOM BE
    }
    if (enc === 2) return trimNull(new TextDecoder('utf-16be').decode(rest));
    if (enc === 3) return trimNull(new TextDecoder('utf-8').decode(rest));
  } catch { /* кодек недоступен */ }
  return trimNull(new TextDecoder('utf-8', { fatal: false }).decode(rest));
}
const trimNull = (s) => s.replace(/\u0000+$/g, '').replace(/\u0000.*$/s, '').trim();

function parseId3(dv, u8, major, flags, { withCover }) {
  const out = {};
  let pos = 10;
  const limit = u8.length;

  // расширенный заголовок
  if (flags & 0x40 && pos + 4 <= limit) {
    const eh = major >= 4 ? synchsafe(dv, pos) : (u32(dv, pos) + 4);
    pos += Math.max(0, eh);
  }

  const idLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;
  const idRe = major === 2 ? /^[A-Z0-9]{3}$/ : /^[A-Z0-9]{4}$/;

  while (pos + hdrLen <= limit) {
    let id = '';
    for (let i = 0; i < idLen; i++) id += String.fromCharCode(u8[pos + i]);
    if (!idRe.test(id)) break;
    let size;
    if (major === 2) size = (u8[pos + 3] << 16) | (u8[pos + 4] << 8) | u8[pos + 5];
    else if (major === 4) size = synchsafe(dv, pos + 4);
    else size = u32(dv, pos + 4);
    if (size <= 0 || pos + hdrLen + size > limit) break;
    const data = u8.subarray(pos + hdrLen, pos + hdrLen + size);

    switch (id) {
      case 'TIT2': case 'TT2': out.title = out.title || decodeText(data); break;
      case 'TPE1': case 'TP1': out.artist = out.artist || decodeText(data); break;
      case 'TALB': case 'TAL': out.album = out.album || decodeText(data); break;
      case 'TDRC': case 'TYER': case 'TYE': out.year = out.year || decodeText(data).slice(0, 4); break;
      case 'APIC': case 'PIC': {
        if (withCover && !out.cover) out.cover = parsePicture(data, major === 2);
        break;
      }
    }
    pos += hdrLen + size;
  }
  return out;
}

function parsePicture(data, isV22) {
  try {
    const enc = data[0];
    let p = 1;
    let mime = 'image/jpeg';
    if (isV22) {
      mime = ascii(data.subarray(1, 4)).toLowerCase();
      if (mime === 'jpg') mime = 'image/jpeg';
      p = 4;
    } else {
      let end = p;
      while (end < data.length && data[end] !== 0) end++;
      mime = ascii(data.subarray(p, end)).toLowerCase() || 'image/jpeg';
      p = end + 1;
    }
    p += 1; // тип картинки
    // описание (заканчивается 0x00; для UTF-16 — 0x0000)
    if (enc === 1 || enc === 2) {
      while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
      p += 2;
    } else {
      while (p < data.length && data[p] !== 0) p++;
      p += 1;
    }
    if (p >= data.length) return null;
    const imgData = data.subarray(p);
    if (imgData.length < 100) return null;
    return new Blob([imgData], { type: mime });
  } catch {
    return null;
  }
}

/** Парсинг текста M3U/PLS: возвращает [{ name, artist, title }] */
export function parseM3U(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let pending = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      const info = comma >= 0 ? line.slice(comma + 1).trim() : '';
      const dash = info.indexOf(' - ');
      pending = dash > 0
        ? { artist: info.slice(0, dash).trim(), title: info.slice(dash + 3).trim() }
        : { artist: '', title: info };
    } else if (line.startsWith('#')) {
      continue;
    } else {
      const base = line.split(/[\\/]/).pop() || line;
      const clean = decodeURIComponent(base.replace(/\+/g, '%2B')).replace(/%20/g, ' ');
      out.push({ name: clean, artist: pending?.artist || '', title: pending?.title || '' });
      pending = null;
    }
  }
  return out;
}
