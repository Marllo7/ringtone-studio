// Модульные тесты чистой логики (запуск: node tests/unit.mjs)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name); }
};

const ROOT = fileURLToPath(new URL('../', import.meta.url));

console.log('== engine: trackInfoFromName ==');
const engine = await import('../js/engine.js');
const t1 = engine.trackInfoFromName('01. AC-DC - Back In Black.mp3');
ok(t1.artist === 'AC-DC' && t1.title === 'Back In Black', 'артист - название с номером');
const t2 = engine.trackInfoFromName('Песня про море.mp3');
ok(t2.artist === '' && t2.title === 'Песня про море', 'только название');
const t3 = engine.trackInfoFromName('12 Кино — Группа крови.flac');
ok(t3.artist === 'Кино' && t3.title === 'Группа крови', 'тире-минус длинное');
const t4 = engine.trackInfoFromName('03.Название без артиста.mp3');
ok(t4.artist === '' && t4.title === 'Название без артиста', 'номер с точкой, без артиста');
const t5 = engine.trackInfoFromName('A-Ha – Take On Me.mp3');
ok(t5.artist === 'A-Ha' && t5.title === 'Take On Me', 'короткое тире (en dash)');
const t6 = engine.trackInfoFromName('07 - Сплин - Выход.mp3');
ok(t6.artist === 'Сплин' && t6.title === 'Выход', 'номер через дефиз-пробел');

console.log('== engine: isAudioName / extOf ==');
ok(engine.isAudioName('a.mp3') && engine.isAudioName('B.M4A') && !engine.isAudioName('c.txt') && !engine.isAudioName('noext'), 'расширения');
ok(engine.isAudioName('x.opus') && engine.isAudioName('y.webm') && engine.isAudioName('z.flac') && engine.isAudioName('w.m4b'), 'редкие расширения');
ok(!engine.isAudioName('a.mp3.exe'), 'двойное расширение');
ok(engine.extOf('Song.MP3') === 'mp3' && engine.extOf('файл') === '', 'extOf');

console.log('== engine: fmtTime / fmtBytes / fmtDate ==');
ok(engine.fmtTime(75) === '1:15' && engine.fmtTime(75.46, true) === '1:15.4', 'формат времени');
ok(engine.fmtTime(0) === '0:00' && engine.fmtTime(-5) === '0:00' && engine.fmtTime(NaN) === '0:00', 'нулевое/негативное время');
ok(engine.fmtTime(59.9) === '0:59' && engine.fmtTime(60) === '1:00', 'граница минуты');
ok(engine.fmtBytes(0) === '0 МБ' && engine.fmtBytes(-10) === '0 МБ', 'fmtBytes ноль');
ok(engine.fmtBytes(2048) === '2 КБ', 'fmtBytes килобайты');
ok(engine.fmtBytes(5 * 1024 * 1024) === '5.0 МБ', 'fmtBytes мегабайты');
ok(engine.fmtDate(0) === '01.01.1970', 'fmtDate');

console.log('== engine: fidOf ==');
ok(engine.fidOf({ name: 'a.mp3', size: 100 }) === engine.fidOf({ name: 'a.mp3', size: 100 }), 'одинаковые файлы = один fid');
ok(engine.fidOf({ name: 'a.mp3', size: 100 }) !== engine.fidOf({ name: 'a.mp3', size: 101 }), 'разный размер = разный fid');

console.log('== engine: clamp ==');
ok(engine.clamp(5, 0, 3) === 3 && engine.clamp(-1, 0, 3) === 0 && engine.clamp(2, 0, 3) === 2, 'clamp');

console.log('== engine: analyze ==');
// фейковый буфер: 2с тишины, 2с громкий синус 440Гц
const SR = 44100, N = SR * 4;
const data = new Float32Array(N);
for (let i = SR * 2; i < N; i++) data[i] = Math.sin(2 * Math.PI * 440 * i / SR) * 0.8;
const fakeBuffer = {
  sampleRate: SR, length: N, duration: 4, numberOfChannels: 1,
  getChannelData: () => data,
};
const an = engine.analyze(fakeBuffer);
ok(an.nB > 0 && an.duration === 4, 'analyze базовые поля');
ok(an.energy[an.nB - 1] > an.energy[0] * 10, 'энергия: громкий конец громче тихого начала');
ok(an.mono.length === N, 'моно-микс покрывает весь буфер');
// стерео: усреднение каналов
const chL = new Float32Array(2048).fill(0.5);
const chR = new Float32Array(2048).fill(-0.25);
const stBuf = { sampleRate: SR, length: 2048, duration: 2048 / SR, numberOfChannels: 2, getChannelData: (c) => (c === 0 ? chL : chR) };
const anSt = engine.analyze(stBuf);
ok(Math.abs(anSt.mono[0] - 0.125) < 1e-6, 'стерео → среднее каналов');
ok(anSt.nB === 1, 'короткий буфер = один бакет');

console.log('== engine: findLoudest ==');
const loud = engine.findLoudest(an, 1);
ok(loud >= 1.9 && loud <= 3.1, `findLoudest(1с) → ${loud.toFixed(2)} (ожидание 2..3)`);
ok(engine.findLoudest(an, 10) === 0, 'окно длиннее трека → 0');
const anSil = engine.analyze({ sampleRate: SR, length: SR, duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(SR) });
ok(Number.isFinite(engine.findLoudest(anSil, 0.5)), 'тишина: без NaN');
const lBig = engine.findLoudest(an, 3.5);
ok(lBig + 3.5 <= 4 + 1e-9 && lBig >= 0, 'окно не вылезает за конец трека');

console.log('== engine: peaksFor ==');
const pk = engine.peaksFor(an, 0, 4, 200);
ok(pk.mins.length === 200 && pk.maxs.length === 200, 'peaksFor размер');
const pk2 = engine.peaksFor(an, 2.5, 2.6, 50);
let maxAmp = 0; for (const v of pk2.maxs) if (v > maxAmp) maxAmp = v;
ok(maxAmp > 0.6, `peaksFor амплитуда громкого места ${maxAmp.toFixed(2)} > 0.6`);
const pk3 = engine.peaksFor(an, 0, 0.1, 50);
let maxAmp2 = 0; for (const v of pk3.maxs) if (v > maxAmp2) maxAmp2 = v;
ok(maxAmp2 < 0.01, `peaksFor тишина ${maxAmp2.toFixed(4)} < 0.01`);
const pk4 = engine.peaksFor(an, 5, 6, 30); // за пределами трека
ok(pk4.maxs.every(v => v === 0), 'диапазон за концом трека → тишина');
const pk5 = engine.peaksFor(an, 1.5, 1.5, 10); // пустой диапазон
ok(pk5.mins.every(v => v === 0), 'from == to → нули');

console.log('== engine: renderClip (обрезка) ==');
// стаб AudioContext для Node
class FakeAC {
  createBuffer(chs, n, sr) {
    const chans = Array.from({ length: chs }, () => new Float32Array(n));
    return { sampleRate: sr, length: n, numberOfChannels: chs, duration: n / sr, getChannelData: (c) => chans[c] };
  }
}
globalThis.window = { AudioContext: FakeAC };

function constBuf(sec, value) {
  const n = Math.round(SR * sec);
  const d = new Float32Array(n).fill(value);
  return { sampleRate: SR, length: n, duration: sec, numberOfChannels: 1, getChannelData: () => d };
}
const buf2s = constBuf(2, 0.5);
const clip = engine.renderClip(buf2s, 0.5, 1.5, 0.25, 0.25, 0);
const cd = clip.getChannelData(0);
ok(clip.length === SR, `длина отрезка ${clip.length} = 1с × ${SR}`);
ok(Math.abs(cd[0]) < 1e-6, 'фейд-ин: первый сэмпл тишина');
ok(Math.abs(cd[SR - 1]) < 0.01, 'фейд-аут: последний сэмпл затухает');
ok(Math.abs(cd[Math.floor(SR / 2)] - 0.5) < 1e-6, 'середина без изменений');
const clipNg = engine.renderClip(buf2s, 0, 1, 0, 0, 6); // +6 дБ = ×2
const cdNg = clipNg.getChannelData(0);
let maxV = 0; for (let i = 0; i < cdNg.length; i++) if (Math.abs(cdNg[i]) > maxV) maxV = Math.abs(cdNg[i]);
ok(maxV <= 0.98 * 1.000002, `авто-лимит громкости: пик ${maxV.toFixed(5)} ≈ 0.98 (Float32)`);
const clipHugeFade = engine.renderClip(buf2s, 0, 1, 5, 5, 0); // фейды длиннее отрезка
const cdHF = clipHugeFade.getChannelData(0);
ok(cdHF.every(v => Number.isFinite(v) && Math.abs(v) <= 1), 'фейды длиннее отрезка не ломают рендер');
const clipOob = engine.renderClip(buf2s, 1.9, 5, 0, 0, 0); // конец за пределами
ok(clipOob.length <= SR * 0.1 + 1, 'границы обрезки клампятся по длине трека');
const stClip = engine.renderClip(
  { sampleRate: SR, length: SR, duration: 1, numberOfChannels: 2, getChannelData: (c) => (c === 0 ? chL : chR) },
  0, 0.5, 0, 0, 0);
ok(stClip.numberOfChannels === 2 && stClip.length === Math.round(SR * 0.5), 'стерео-отрезок');

console.log('== editor pipeline: обрезка → MP3 (полный цикл) ==');
globalThis.self = globalThis;
const posted = [];
self.postMessage = (msg) => posted.push(msg);
await import('../js/mp3-worker.js');
{
  const src = constBuf(3, 0.4);
  const cut = engine.renderClip(src, 1.0, 2.0, 0.05, 0.05, 0);
  self.onmessage({ data: { cmd: 'encode', channels: 1, sampleRate: SR, bitrate: 128, left: cut.getChannelData(0), right: null } });
  const done = posted.find(m => m.type === 'done');
  ok(!!done && done.mp3.length > 8000, `MP3 из отрезка = ${done?.mp3.length} байт`);
  ok(done && done.mp3[0] === 0xff && (done.mp3[1] & 0xe0) === 0xe0, 'заголовок MPEG корректен');
}

console.log('== id3: readTags (v2.3, utf-8) ==');
const { readTags, parseM3U } = await import('../js/id3.js');
function u32be(n) { return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]; }
function frame(id, text) {
  const body = [3, ...new TextEncoder().encode(text)]; // enc=3 utf-8
  return [...new TextEncoder().encode(id), ...u32be(body.length), 0, 0, ...body];
}
function synchsafe(n) { return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]; }
const frames = [...frame('TIT2', 'Название песни'), ...frame('TPE1', 'Исполнитель')];
const id3 = [0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(frames.length), ...frames];
const mp3File = new File([new Uint8Array(id3), new Uint8Array(2000)], 'test.mp3');
const tags = await readTags(mp3File, {});
ok(tags.title === 'Название песни', `title = "${tags.title}"`);
ok(tags.artist === 'Исполнитель', `artist = "${tags.artist}"`);

console.log('== id3: readTags v2.4 (synchsafe) и v2.2 ==');
function frame24(id, text) {
  const body = [3, ...new TextEncoder().encode(text)];
  return [...new TextEncoder().encode(id), ...synchsafe(body.length), 0, 0, ...body]; // + 2 байта флагов
}
const frames24 = [...frame24('TIT2', 'Тег v2.4')];
const id3v24 = [0x49, 0x44, 0x33, 4, 0, 0, ...synchsafe(frames24.length), ...frames24];
const t24 = await readTags(new File([new Uint8Array(id3v24)], 't24.mp3'), {});
ok(t24.title === 'Тег v2.4', `v2.4 title = "${t24.title}"`);

function frame22(id, text) {
  const body = [3, ...new TextEncoder().encode(text)];
  return [...new TextEncoder().encode(id), (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
}
const frames22 = [...frame22('TT2', 'Тег v2.2')];
const id3v22 = [0x49, 0x44, 0x33, 2, 0, 0, ...synchsafe(frames22.length), ...frames22];
const t22 = await readTags(new File([new Uint8Array(id3v22)], 't22.mp3'), {});
ok(t22.title === 'Тег v2.2', `v2.2 title = "${t22.title}"`);

console.log('== id3: обложка APIC ==');
function apicFrame(mime, payload) {
  const enc = [0];
  const m = [...new TextEncoder().encode(mime), 0];
  const picType = [3]; // обложка альбома
  const desc = [0];
  return [...new TextEncoder().encode('APIC'), ...u32be(enc.length + m.length + picType.length + desc.length + payload.length), 0, 0, ...enc, ...m, ...picType, ...desc, ...payload];
}
const jpg = Array.from({ length: 500 }, (_, i) => i % 256);
const withCover = [...apicFrame('image/jpeg', jpg)];
const id3Cover = [0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(withCover.length), ...withCover];
const tCover = await readTags(new File([new Uint8Array(id3Cover), new Uint8Array(500)], 'cover.mp3'), { withCover: true });
ok(tCover.cover instanceof Blob && tCover.cover.size === 500, `APIC blob = ${tCover.cover?.size} байт`);
ok(tCover.cover?.type === 'image/jpeg', 'APIC mime');

console.log('== id3: не-mp3 файлы ==');
ok(Object.keys(await readTags(new File([new Uint8Array(100)], 'plain.mp3'), {})).length === 0, 'нет ID3 → пусто');
ok(Object.keys(await readTags(new File([new Uint8Array(5)], 'tiny.mp3'), {})).length === 0, 'файл < 10 байт → пусто');
ok(Object.keys(await readTags(new File([new TextEncoder().encode('ID3\x04\x00\x00\x00\x00\x00\x00garbage')], 'bad.mp3'), {})).length === 0, 'битый заголовок → пусто');

console.log('== id3: parseM3U ==');
const m3u = `#EXTM3U
#EXTINF:213,Кино - Группа крови
/Music/Russian/Кино - Группа крови.mp3
#EXTINF:-1,Unknown Artist - Track
rock/song1.mp3
`;
const entries = parseM3U(m3u);
ok(entries.length === 2, 'два трека');
ok(entries[0].name === 'Кино - Группа крови.mp3' && entries[0].artist === 'Кино', 'первая запись');
ok(entries[1].name === 'song1.mp3', 'вторая запись (относительный путь)');
const m3uWin = parseM3U('#EXTINF:1,Test\nC:\\Music\\My File.mp3');
ok(m3uWin[0].name === 'My File.mp3', 'windows-путь');
const m3uEnc = parseM3U('http://x/y/My%20Song.mp3');
ok(m3uEnc[0].name === 'My Song.mp3', '%20 декодируется');
ok(parseM3U('#EXTM3U\n#комментарий').length === 0, 'только комментарии → пусто');

console.log('== export: sanitizeFilename ==');
const { sanitizeFilename } = await import('../js/export.js');
ok(sanitizeFilename('a/b:c*d?"<>|e') === 'abcde', 'запрещённые символы вырезаются');
ok(sanitizeFilename('   ') === 'ringtone', 'пустое имя → ringtone');
ok(sanitizeFilename('x'.repeat(100)).length === 80, 'обрезка до 80 символов');
ok(sanitizeFilename('  Название  трека  ') === 'Название трека', 'пробелы схлопываются');

console.log('== mp3-worker: полный цикл кодирования ==');
posted.length = 0;
const n2 = SR;
const left = new Float32Array(n2);
for (let i = 0; i < n2; i++) left[i] = Math.sin(2 * Math.PI * 440 * i / SR) * 0.5;
self.onmessage({ data: { cmd: 'encode', channels: 1, sampleRate: SR, bitrate: 128, left, right: null } });
const doneMsg = posted.find(m => m.type === 'done');
ok(!!doneMsg, 'воркер завершился');
ok(doneMsg && doneMsg.mp3 instanceof Uint8Array && doneMsg.mp3.length > 10000, `размер MP3 = ${doneMsg?.mp3.length}`);
ok(doneMsg && doneMsg.mp3[0] === 0xff && (doneMsg.mp3[1] & 0xe0) === 0xe0, 'заголовок MPEG корректен');
ok(posted.some(m => m.type === 'progress' && m.progress > 0 && m.progress <= 1), 'прогресс отправлялся');

// стерео-вариант
posted.length = 0;
const l2 = new Float32Array(n2 / 2).fill(0.3);
const r2 = new Float32Array(n2 / 2).fill(-0.3);
self.onmessage({ data: { cmd: 'encode', channels: 2, sampleRate: SR, bitrate: 192, left: l2, right: r2 } });
const done2 = posted.find(m => m.type === 'done');
ok(!!done2 && done2.mp3.length > 3000, `стерео MP3 = ${done2?.mp3.length}`);

console.log('== icons: набор и путь-данные ==');
const { ICON_PATHS, icon } = await import('../js/icons.js');
const iconNames = Object.keys(ICON_PATHS);
ok(iconNames.length >= 25, `в наборе ${iconNames.length} иконок`);
ok(iconNames.every(n => /^M/.test(ICON_PATHS[n])), 'каждый путь начинается с M');
ok(iconNames.every(n => /^[MmLlHhVvCcSsQqTtAaZz0-9,\s.\-eE+]+$/.test(ICON_PATHS[n])), 'пути содержат только валидные команды SVG');
ok(icon('play').startsWith('<svg') && icon('play').includes('</svg>'), 'icon() возвращает SVG');
ok(icon('no-such-icon') === '', 'неизвестное имя → пустая строка');
// все иконки, используемые в коде, существуют в наборе
const used = new Set();
for (const f of readdirSync(new URL('../js/', import.meta.url)).filter(x => x.endsWith('.js'))) {
  const src = readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');
  for (const m of src.matchAll(/icon\(\s*'([a-zA-Z]+)'/g)) used.add(m[1]);
}
const htmlSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
for (const m of htmlSrc.matchAll(/data-icon="([a-zA-Z]+)"/g)) used.add(m[1]);
const missing = [...used].filter(n => !ICON_PATHS[n]);
ok(missing.length === 0, `все используемые иконки существуют (${[...used].join(', ')})`);

console.log('== целостность ресурсов (деплой) ==');
const swSrc = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const assets = [...swSrc.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
ok(assets.length >= 20, `sw.js кэширует ${assets.length} ресурсов`);
const missingAssets = assets.filter(a => !existsSync(ROOT + a));
ok(missingAssets.length === 0, missingAssets.length ? `нет файлов: ${missingAssets.join(', ')}` : 'все файлы из sw.js существуют');
const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
const missingIcons = manifest.icons.map(i => i.src.replace('./', '')).filter(p => !existsSync(ROOT + p));
ok(missingIcons.length === 0, 'иконки манифеста существуют');
for (const m of htmlSrc.matchAll(/(?:src|href)="\.(\/(?:js|css)\/[^"]+)"/g)) {
  ok(existsSync(ROOT + m[1]), `index.html подключает ${m[1]}`);
}
ok(manifest.name === 'Ringtone Studio', 'манифест: английское название');

console.log(`\nИтого: ${pass} ок, ${fail} провалено`);
process.exit(fail ? 1 : 0);
