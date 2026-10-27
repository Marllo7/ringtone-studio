// mp3-worker.js — кодирование MP3 в фоновом потоке (lamejs, локальный файл)

import '../lib/lame.min.js';

self.onmessage = (e) => {
  const { cmd, channels, sampleRate, bitrate, left, right } = e.data;
  if (cmd !== 'encode') return;
  const lamejs = globalThis.lamejs;
  if (!lamejs) {
    self.postMessage({ type: 'error', error: 'Кодировщик не загружен' });
    return;
  }
  try {
    const enc = new lamejs.Mp3Encoder(channels, sampleRate, bitrate);
    const CH = 1152;
    const n = left.length;
    const parts = [];
    const total = Math.max(1, Math.ceil(n / CH));
    let done = 0;
    let lastPost = -1;

    // lamejs принимает Int16
    const l16 = new Int16Array(CH);
    const r16 = channels > 1 ? new Int16Array(CH) : null;

    for (let i = 0; i < n; i += CH) {
      const len = Math.min(CH, n - i);
      for (let j = 0; j < len; j++) {
        let v = left[i + j];
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        l16[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (r16) {
          let w = right[i + j];
          w = w < -1 ? -1 : w > 1 ? 1 : w;
          r16[j] = w < 0 ? w * 0x8000 : w * 0x7fff;
        }
      }
      const sl = len < CH ? l16.subarray(0, len) : l16;
      const sr = r16 ? (len < CH ? r16.subarray(0, len) : r16) : null;
      const out = channels > 1 ? enc.encodeBuffer(sl, sr) : enc.encodeBuffer(sl);
      if (out.length) parts.push(out);
      done++;
      // прогресс шлём порциями
      if (done - lastPost >= Math.max(1, Math.floor(total / 20)) || i + CH >= n) {
        lastPost = done;
        self.postMessage({ type: 'progress', progress: done / total });
      }
    }
    const tail = enc.flush();
    if (tail.length) parts.push(tail);
    const totalBytes = parts.reduce((a, b) => a + b.length, 0);
    const mp3 = new Uint8Array(totalBytes);
    let off = 0;
    for (const p of parts) { mp3.set(p, off); off += p.length; }
    self.postMessage({ type: 'done', mp3 }, [mp3.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
};
