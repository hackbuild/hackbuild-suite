// A generated test recording for smokes, shots and tests: 16 kHz mono
// 16 bit pcm, 8 s, a low noise floor with three voiced bursts (a 140 Hz
// buzz with harmonics, moved by a 4 Hz syllable envelope). No real voice.
export function testWav(seconds = 8, rate = 16000) {
  const n = seconds * rate
  const data = new Int16Array(n)
  const bursts = [[0.6, 2.4], [3.2, 5.0], [5.8, 7.4]]
  let seed = 7
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.004
  for (let i = 0; i < n; i++) {
    const t = i / rate
    let v = noise()
    if (bursts.some(([a, b]) => t >= a && t < b)) {
      const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)
      for (let h = 1; h <= 8; h++) v += (env * 0.12 * Math.sin(2 * Math.PI * 140 * h * t)) / h
    }
    data[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
  }
  const buf = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(buf)
  const str = (o, s) => [...s].forEach((c, k) => dv.setUint8(o + k, c.charCodeAt(0)))
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  str(36, 'data'); dv.setUint32(40, n * 2, true)
  new Int16Array(buf, 44).set(data)
  return new Uint8Array(buf)
}
