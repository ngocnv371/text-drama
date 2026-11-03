// Soundtrack: synthesised message pops, keyboard clicks and bass hits on bombshells, over a
// quiet ambience track (src/music.js) that drops away right before each reveal.
import fs from "node:fs";

export const RATE = 44100;
const LOOP_FADE = 3;   // seconds of crossfade when a track is shorter than the video

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// music: { L, R } float samples or null; volumeDb: the music's average level (RMS, dBFS).
export function synthesize(tl, music = null, volumeDb = -30) {
  const n = Math.ceil(tl.duration * RATE) + RATE;
  const out = new Float32Array(n);
  const rand = rng(7);

  const add = (start, dur, fn, gain = 1) => {
    const i0 = Math.floor(start * RATE);
    const len = Math.floor(dur * RATE);
    for (let i = 0; i < len && i0 + i < n; i++) {
      if (i0 + i < 0) continue;
      out[i0 + i] += gain * fn(i / RATE);
    }
  };
  const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));

  // incoming: two-note chime
  const receive = (t) => {
    const f = t < 0.07 ? 1318.5 : 1760;
    return Math.sin(2 * Math.PI * f * t) * env(t, 0.004, 0.09) * 0.5 + Math.sin(2 * Math.PI * f * 2 * t) * env(t, 0.002, 0.04) * 0.1;
  };
  // outgoing: quick upward swoosh
  const send = (t) => {
    const f = 500 + 2600 * t;
    return Math.sin(2 * Math.PI * f * t) * env(t, 0.01, 0.05) * 0.4 + (rand() * 2 - 1) * env(t, 0.005, 0.03) * 0.12;
  };
  const click = (t) => (rand() * 2 - 1) * env(t, 0.0008, 0.006) * 0.35;
  // bombshell: sub drop + noise burst
  const boom = (t) => {
    const f = 70 * Math.exp(-t * 2.5) + 32;
    return Math.sin(2 * Math.PI * f * t) * env(t, 0.005, 0.55) * 1.0 + (rand() * 2 - 1) * env(t, 0.002, 0.08) * 0.5;
  };
  const unsend = (t) => Math.sin(2 * Math.PI * (1400 - 2200 * t) * t) * env(t, 0.01, 0.07) * 0.35;
  const sting = (t) => [220, 261.6, 329.6].reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) * env(t, 0.02, 0.9) * 0.18;

  for (const m of tl.messages) {
    if (m.type === "system") continue; // notices get their own sound below
    if (m.from === "me") {
      add(m.appear, 0.25, send, 0.9);
      // keyboard clicks while composing
      const [a, b] = m.compose;
      for (let x = a; x < b; x += 0.07 + rand() * 0.05) add(x, 0.03, click);
    } else {
      add(m.appear, 0.3, receive, m.beat === "bombshell" ? 0.6 : 0.8);
    }
  }
  // system notice: soft two-note knock; reaction: tiny bubbly pop (bigger piles get a second pop)
  const knock = (t) => {
    const f = t < 0.09 ? 587 : 440;
    return Math.sin(2 * Math.PI * f * t) * env(t % 0.09, 0.003, 0.05) * 0.45;
  };
  const pop = (t) => Math.sin(2 * Math.PI * (900 + 1800 * Math.exp(-t * 40)) * t) * env(t, 0.002, 0.03) * 0.35;

  for (const f of tl.fx) {
    if (f.type === "bombshell") add(f.t, 1.8, boom, 0.9);
    if (f.type === "unsend") add(f.t, 0.3, unsend);
    if (f.type === "system") add(f.t, 0.3, knock);
    if (f.type === "reaction") {
      add(f.t, 0.12, pop, 0.8);
      if (f.count >= 10) add(f.t + 0.09, 0.12, pop, 0.5);
    }
  }
  add(tl.outroAt, 2.5, sting);

  // Effects are mono, centred; the music keeps its stereo.
  const L = Float32Array.from(out), R = Float32Array.from(out);
  if (music) mixMusic(L, R, music, tl, volumeDb);

  // soft clip
  for (let i = 0; i < n; i++) { L[i] = Math.tanh(L[i] * 1.1) * 0.9; R[i] = Math.tanh(R[i] * 1.1) * 0.9; }
  return { L, R };
}

function mixMusic(L, R, music, tl, volumeDb) {
  const len = music.L.length;
  if (!len) return;
  // Same loudness for every track, whatever level it was made at.
  let sum = 0;
  for (let i = 0; i < len; i++) sum += music.L[i] * music.L[i] + music.R[i] * music.R[i];
  const rms = Math.sqrt(sum / (2 * len)) || 1;
  const gain = 10 ** (volumeDb / 20) / rms;

  // Loop with a crossfade if the video outlasts the track.
  const xf = Math.min(Math.floor(LOOP_FADE * RATE), Math.floor(len / 4));
  const period = len - xf;
  const at = (ch, i) => {
    if (i < len) return ch[i];
    const local = i % period;
    if (local >= xf) return ch[local];
    const w = local / xf;
    return ch[local] * w + ch[local + period] * (1 - w);
  };

  const bombs = tl.fx.filter((f) => f.type === "bombshell").map((f) => f.t);
  const end = tl.duration;
  for (let i = 0; i < L.length; i++) {
    const t = i / RATE;
    if (t >= end) break;
    // Drop almost to silence just before a reveal, then swell back.
    let duck = 1;
    for (const b of bombs) {
      if (t > b - 0.6 && t < b) duck = Math.min(duck, 0.08 + 0.92 * ((b - t) / 0.6) ** 2);
      if (t >= b && t < b + 1.5) duck = Math.min(duck, 0.08 + 0.92 * ((t - b) / 1.5));
    }
    const fade = Math.min(1, t / 0.8, (end - t) / 2.5);
    const g = gain * duck * Math.max(0, fade);
    L[i] += at(music.L, i) * g;
    R[i] += at(music.R, i) * g;
  }
}
// 16-bit stereo WAV.
export function writeWav(file, { L, R }) {
  const n = L.length, bytes = n * 4;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + bytes, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(bytes, 40);
  const q = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(q(L[i]), 44 + i * 4); buf.writeInt16LE(q(R[i]), 46 + i * 4); }
  fs.writeFileSync(file, buf);
}
