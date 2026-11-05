// Background music: ambience tracks (assets/music, or the workspace's own music/ folder), one
// picked at random per episode.
// The pick is saved in the episode's meta.json, so re-rendering keeps the same track.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, episodeDir, episodesDir, workspaceDir } from "./util.js";

const SHARED_MUSIC = path.join(ROOT, "assets", "music");
const AUDIO = /\.(mp3|flac|opus|ogg|wav|m4a)$/i;

// A workspace can have its own music/ folder; otherwise it uses the shared assets/music.
export function musicDir() {
  const own = path.join(workspaceDir(), "music");
  return fs.existsSync(own) && fs.readdirSync(own).some((f) => AUDIO.test(f)) ? own : SHARED_MUSIC;
}

export function listTracks() {
  const dir = musicDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => AUDIO.test(f)).sort();
}

function readMeta(id) {
  const file = path.join(episodeDir(id), "meta.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

// The episode's track, choosing one now if it has none. Avoids the previous episode's track
// so back-to-back videos don't sound alike. Returns null when there is no music at all.
export function trackFor(id) {
  const tracks = listTracks();
  if (!tracks.length) return null;
  const meta = readMeta(id);
  if (meta.music && tracks.includes(meta.music)) return path.join(musicDir(), meta.music);

  const others = fs.readdirSync(episodesDir())
    .filter((name) => name !== id && /^ep\d+$/.test(name) && name < id)
    .sort();
  const previous = others.length ? readMeta(others.at(-1)).music : null;
  const pool = tracks.length > 1 ? tracks.filter((t) => t !== previous) : tracks;
  meta.music = pool[Math.floor(Math.random() * pool.length)];
  fs.writeFileSync(path.join(episodeDir(id), "meta.json"), JSON.stringify(meta, null, 2));
  return path.join(musicDir(), meta.music);
}

// Decode to 44.1 kHz stereo floats.
export function decodeTrack(file, rate) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "2", "-ar", String(rate), "pipe:1"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`could not decode ${file}: ${r.stderr}`);
  const pcm = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
  // Generated tracks often trail off into seconds of silence; cut it so a loop doesn't hit a gap.
  const SILENT = 0.003;   // about -50 dBFS
  const frames = pcm.length / 2;
  const loud = (i) => Math.abs(pcm[2 * i]) > SILENT || Math.abs(pcm[2 * i + 1]) > SILENT;
  let first = 0, last = frames - 1;
  while (first < last && !loud(first)) first++;
  while (last > first && !loud(last)) last--;
  first = Math.max(0, first - Math.floor(0.05 * rate));
  last = Math.min(frames - 1, last + Math.floor(0.2 * rate));
  const n = last - first + 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = pcm[2 * (first + i)]; R[i] = pcm[2 * (first + i) + 1]; }
  // Under phone audio, sustained sub-bass from a track reads as a hum (one generated track sat
  // a sixth of its energy at 55 Hz). Keep the bed above it; bombshell hits are effects, not music.
  for (const ch of [L, R]) { highPass(ch, rate, 80); highPass(ch, rate, 80); }
  return { L, R };
}

// 2nd-order Butterworth high-pass, in place. Applied twice: 24 dB/octave.
function highPass(x, rate, freq) {
  const w = 2 * Math.PI * freq / rate, cos = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0, b1 = -(1 + cos) / a0, b2 = b0, a1 = -2 * cos / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
}
