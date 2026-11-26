// What the listen examples share: speech written in code, so a voice plays
// and a mouth moves with nothing downloaded, and a sample recording to drop.

/** A word with its span in the text and its time in the audio, in seconds. */
export interface TimedWord {
  start: number;
  end: number;
  t0: number;
  t1: number;
}

/**
 * A hum shaped like speech, one swell per syllable, with the word timings a
 * speech engine would report. It stands in for a voice model.
 */
export function codeVoice(text: string, rate = 22050): { audio: AudioBuffer; words: TimedWord[] } {
  const words: TimedWord[] = [];
  let t = 0.08;
  for (const m of text.matchAll(/[a-z0-9']+/gi)) {
    const syl = Math.max(1, (m[0].match(/[aeiouy]+/gi) ?? []).length);
    const d = 0.16 + syl * 0.13;
    words.push({ t0: t, t1: t + d, start: m.index!, end: m.index! + m[0].length });
    t += d + (/[.,]/.test(text[m.index! + m[0].length] ?? "") ? 0.22 : 0.06);
  }
  const length = Math.ceil((t + 0.1) * rate);
  const audio = new AudioBuffer({ length, sampleRate: rate, numberOfChannels: 1 });
  const out = audio.getChannelData(0);
  // overtones near the first two formants of an open vowel, 700 and 1200 hz
  const gain = (hz: number) => Math.exp(-(((hz - 700) / 260) ** 2)) + 0.6 * Math.exp(-(((hz - 1200) / 320) ** 2)) + 0.25 / (1 + hz / 300);
  let phase = 0;
  for (const w of words) {
    const syl = Math.max(1, Math.round((w.t1 - w.t0 - 0.16) / 0.13));
    for (let i = Math.floor(w.t0 * rate); i < Math.min(length, Math.ceil(w.t1 * rate)); i++) {
      const u = (i / rate - w.t0) / (w.t1 - w.t0);
      const f0 = 128 - 14 * u;
      phase += (2 * Math.PI * f0) / rate;
      const env = Math.sin(Math.PI * u) * (0.55 + 0.45 * Math.abs(Math.sin(Math.PI * u * syl)));
      let v = 0;
      for (let k = 1; k * f0 < 3000; k++) v += gain(k * f0) * Math.sin(k * phase);
      out[i] = 0.12 * env * v;
    }
  }
  return { audio, words };
}

/** A short wav of quiet, named like a recording, for the sample drop. */
export function sampleRecording(name: string, seconds = 1): Blob & { name: string } {
  const rate = 16000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, n * 2, true);
  return Object.assign(new Blob([buf], { type: "audio/wav" }), { name });
}
