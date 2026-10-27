// Модульные тесты чистой логики (запуск: node tests/unit.mjs)
let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name); }
};

console.log('== engine: trackInfoFromName ==');
const engine = await import('../js/engine.js');
const t1 = engine.trackInfoFromName('01. AC-DC - Back In Black.mp3');
ok(t1.artist === 'AC-DC' && t1.title === 'Back In Black', 'артист - название с номером');
const t2 = engine.trackInfoFromName('Песня про море.mp3');
ok(t2.artist === '' && t2.title === 'Песня про море', 'только название');
const t3 = engine.trackInfoFromName('12 Кино — Группа крови.flac');
ok(t3.artist === 'Кино' && t3.title === 'Группа крови', 'тире-минус длинное');

console.log('== engine: isAudioName ==');
ok(engine.isAudioName('a.mp3') && engine.isAudioName('B.M4A') && !engine.isAudioName('c.txt') && !engine.isAudioName('noext'), 'расширения');

console.log('== engine: fmtTime ==');
ok(engine.fmtTime(75) === '1:15' && engine.fmtTime(75.46, true) === '1:15.4', 'формат времени');

console.log('== engine: analyze + findLoudest + peaksFor ==');
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
const loud = engine.findLoudest(an, 1);
ok(loud >= 1.9 && loud <= 3.1, `findLoudest(1с) → ${loud.toFixed(2)} (ожидание 2..3)`);
const pk = engine.peaksFor(an, 0, 4, 200);
ok(pk.mins.length === 200 && pk.maxs.length === 200, 'peaksFor размер');
const pk2 = engine.peaksFor(an, 2.5, 2.6, 50);
let maxAmp = 0; for (const v of pk2.maxs) if (v > maxAmp) maxAmp = v;
ok(maxAmp > 0.6, `peaksFor амплитуда громкого места ${maxAmp.toFixed(2)} > 0.6`);
const pk3 = engine.peaksFor(an, 0, 0.1, 50);
let maxAmp2 = 0; for (const v of pk3.maxs) if (v > maxAmp2) maxAmp2 = v;
ok(maxAmp2 < 0.01, `peaksFor тишина ${maxAmp2.toFixed(4)} < 0.01`);

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

console.log('== mp3-worker: полный цикл кодирования ==');
globalThis.self = globalThis;
const posted = [];
self.postMessage = (msg) => posted.push(msg);
await import('../js/mp3-worker.js');
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

console.log(`\nИтого: ${pass} ок, ${fail} провалено`);
process.exit(fail ? 1 : 0);
