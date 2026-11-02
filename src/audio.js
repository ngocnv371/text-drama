// Synthesised soundtrack: message pops, keyboard clicks, bass hits on bombshells and a
// tension drone that cuts to silence right before each reveal. No audio assets needed.
import fs from "node:fs";

const RATE = 44100;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function synthesize(tl) {
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

  // Tension drone: swells over the episode, ducks to silence ~0.6s before each bombshell.
  const bombs = tl.fx.filter((f) => f.type === "bombshell").map((f) => f.t);
  let phase1 = 0, phase2 = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    if (t > tl.outroAt) break;
    let duck = 1;
    for (const b of bombs) {
      if (t > b - 0.6 && t < b) duck = Math.min(duck, (b - t) / 0.6) ** 2;
      if (t >= b && t < b + 1.5) duck = Math.min(duck, (t - b) / 1.5);
    }
    const swell = 0.05 + 0.08 * (t / tl.outroAt);
    const fade = Math.min(1, t / 1.5, (tl.outroAt - t) / 0.3);
    phase1 += (2 * Math.PI * 55) / RATE;
    phase2 += (2 * Math.PI * 82.4 * (1 + 0.003 * Math.sin(t * 0.7))) / RATE;
    lp += 0.02 * ((rand() * 2 - 1) - lp); // filtered noise for air
    const pulse = 0.7 + 0.3 * Math.sin(2 * Math.PI * 1.6 * t); // heartbeat-ish tremolo
    out[i] += (Math.sin(phase1) * 0.6 + Math.sin(phase2) * 0.4 + lp * 0.8) * swell * pulse * duck * fade;
  }

  // soft clip
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 1.1) * 0.9;
  return out;
}

export function writeWav(file, samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
