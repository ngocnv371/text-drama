// Step 3: render a timeline to mp4. Several headless Edge/Chrome browsers capture frames in
// parallel via seek(t) (every frame can be drawn on its own), frames go to ffmpeg in order, it
// encodes on the GPU when it can, and the soundtrack is muxed in.
// Usage: node src/render.js <episode-id> [--seconds 10] [--frames 0,12.5,30]
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { ROOT, episodeDir, parseArgs, loadConfig, outDir as workspaceOutDir } from "./util.js";
import { writeTimeline } from "./direct.js";
import { synthesize, writeWav, RATE } from "./audio.js";
import { trackFor, decodeTrack } from "./music.js";

// Headless mode never opens a window, so renders don't steal focus.
async function launchBrowser() {
  for (const channel of ["msedge", "chrome"]) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* try next */ }
  }
  return chromium.launch({ headless: true });
}

async function openPlayer(browser, timeline) {
  const { width, height } = timeline.video;
  // Its own context per tab, so tabs render in separate processes.
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript((tl) => { window.TIMELINE = tl; window.__RENDER = true; }, timeline);
  await page.goto(pathToFileURL(path.join(ROOT, "player", "index.html")).href);
  await page.waitForFunction(() => window.PLAYER_READY === true);
  page.cdp = await ctx.newCDPSession(page);
  return page;
}

// Measured on a 6-core/12-thread CPU: one browser tops out near 60 frames/s however many tabs
// it has (they share its GPU process); 6 browsers x 2 tabs reach ~130 frames/s.
const DEFAULT_WORKERS = { browsers: 6, tabsPerBrowser: 2 };

// Hardware H.264 encoders to try before falling back to the CPU (libx264).
const ENCODERS = {
  h264_amf: ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20"],
  h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "constqp", "-qp", "19"],
  h264_qsv: ["-c:v", "h264_qsv", "-global_quality", "20"],
  libx264: ["-c:v", "libx264", "-preset", "medium", "-crf", "18"],
};
let encoderCache = null;

// First encoder that actually works here: being listed by ffmpeg isn't enough (an NVIDIA
// encoder is listed on an AMD machine), so each one encodes a tiny test clip.
function pickEncoder(wanted) {
  if (wanted && wanted !== "auto") {
    if (!ENCODERS[wanted]) throw new Error(`unknown encoder "${wanted}" (use auto, ${Object.keys(ENCODERS).join(", ")})`);
    return wanted;
  }
  if (encoderCache) return encoderCache;
  for (const name of Object.keys(ENCODERS)) {
    const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.2", ...ENCODERS[name], "-pix_fmt", "yuv420p", "-f", "null", "-"]);
    if (r.status === 0) return (encoderCache = name);
  }
  return (encoderCache = "libx264");
}

// Windows refuses to replace a file another program has open (a video player, an old web view).
// Retry briefly; if it stays locked, keep the new video next to it and say so.
async function replaceFile(tmp, target) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, target); return target; } catch (err) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      if (attempt >= 10) {
        const fallback = target.replace(/\.mp4$/, ".new.mp4");
        fs.renameSync(tmp, fallback);
        throw new Error(`${path.relative(ROOT, target)} is open in another program (a video player, or a web view started before this fix), so it can't be replaced. The new video is at ${path.relative(ROOT, fallback)}.`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// The file on disk must be what we meant to make: right size, length, and with sound.
function checkVideo(mp4, timeline, duration) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", mp4], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${mp4}: ${r.stderr}`);
  const info = JSON.parse(r.stdout);
  const video = info.streams.find((s) => s.codec_type === "video");
  const problems = [];
  if (!video || video.width !== timeline.video.width || video.height !== timeline.video.height) problems.push("wrong video size");
  if (!info.streams.some((s) => s.codec_type === "audio")) problems.push("no audio track");
  if (Math.abs(+info.format.duration - duration) > 0.5) problems.push(`duration ${(+info.format.duration).toFixed(1)}s, expected ${duration.toFixed(1)}s`);
  if (problems.length) throw new Error(`video check failed for ${mp4}: ${problems.join(", ")}`);
}

export async function render(id, { seconds, frames } = {}) {
  const timeline = writeTimeline(id);
  const dir = episodeDir(id);
  const outDir = workspaceOutDir();
  fs.mkdirSync(outDir, { recursive: true });
  const settings = { ...DEFAULT_WORKERS, ...loadConfig().render };
  // Stills need one tab; a video gets the whole pool.
  const browserCount = frames ? 1 : Math.max(1, settings.browsers);
  const tabs = frames ? 1 : Math.max(1, settings.tabsPerBrowser);
  const browsers = await Promise.all(Array.from({ length: browserCount }, launchBrowser));
  const pages = await Promise.all(browsers.flatMap((b) => Array.from({ length: tabs }, () => openPlayer(b, timeline))));
  const page = pages[0];

  try {
    const layout = await page.evaluate(() => window.LAYOUT_PROBLEMS);
    if (layout.length && !frames) throw new Error(`[${id}] layout check failed:\n  - ${layout.join("\n  - ")}`);

    if (frames) {
      // stills for quick review
      for (const t of frames) {
        await page.evaluate((tt) => window.seek(tt), t);
        const file = path.join(outDir, `${id}-${String(t).replace(".", "_")}s.png`);
        await page.screenshot({ path: file });
        console.log(path.relative(ROOT, file));
      }
      return;
    }

    const { fps } = timeline.video;
    const duration = Math.min(timeline.duration, seconds ?? Infinity);
    const total = Math.round(duration * fps);
    const wav = path.join(dir, "audio.wav");
    const track = trackFor(id);
    if (track) console.log(`[${id}] music: ${path.basename(track)}`);
    const volumeDb = loadConfig().music?.volumeDb ?? -30;
    writeWav(wav, synthesize(timeline, track ? decodeTrack(track, RATE) : null, volumeDb));
    const mp4 = path.join(outDir, `${id}.mp4`);
    // Render to a temp file and only rename once it passes, so out/ never holds a broken video.
    const tmp = path.join(outDir, `${id}.partial.mp4`);

    const encoder = pickEncoder(settings.encoder);
    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-i", wav,
      "-map", "0:v", "-map", "1:a",
      ...ENCODERS[encoder], "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-t", String(duration), "-movflags", "+faststart",
      "-f", "mp4", tmp,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));

    // Every tab takes the next frame number; finished frames wait in `ready` until all earlier
    // ones are written, so ffmpeg always gets them in order.
    console.log(`[${id}] rendering ${total} frames with ${pages.length} tabs in ${browsers.length} browsers, encoder ${encoder}`);
    const started = Date.now();
    const ready = new Map();
    const AHEAD = 120;   // cap on frames held in memory while waiting for an earlier one
    let next = 0, written = 0, waiters = [];
    const flush = async () => {
      while (ready.has(written)) {
        const jpg = ready.get(written);
        ready.delete(written);
        if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
        written++;
        if (written % fps === 0) process.stdout.write(`\rframe ${written}/${total}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
      }
      const w = waiters; waiters = []; w.forEach((r) => r());
    };
    let writing = Promise.resolve();
    await Promise.all(pages.map(async (p) => {
      while (next < total) {
        if (next - written > AHEAD) { await new Promise((r) => waiters.push(r)); continue; }
        const f = next++;
        await p.evaluate((tt) => window.seek(tt), f / fps);
        const { data } = await p.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true });
        ready.set(f, Buffer.from(data, "base64"));
        writing = writing.then(flush);
      }
    }));
    await writing;
    ff.stdin.end();
    await done;
    const secs = (Date.now() - started) / 1000;
    try { checkVideo(tmp, timeline, duration); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
    await replaceFile(tmp, mp4);
    console.log(`\nwrote ${path.relative(ROOT, mp4)} (${duration.toFixed(1)}s video in ${secs.toFixed(0)}s, ${(total / secs).toFixed(0)} frames/s)`);
    return mp4;
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
  }
}

if (import.meta.main) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  await render(positional[0] ?? "pilot", {
    seconds: flags.seconds ? +flags.seconds : undefined,
    frames: flags.frames ? String(flags.frames).split(",").map(Number) : undefined,
  });
}
