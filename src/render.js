// Step 3: render a timeline to mp4. Headless Edge/Chrome captures each frame via seek(t),
// frames are piped straight into ffmpeg, and the synthesised soundtrack is muxed in.
// Usage: node src/render.js <episode-id> [--seconds 10] [--frames 0,12.5,30]
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { ROOT, episodeDir, parseArgs } from "./util.js";
import { writeTimeline } from "./direct.js";
import { synthesize, writeWav } from "./audio.js";

// Headless mode never opens a window, so renders don't steal focus.
async function launchBrowser() {
  for (const channel of ["msedge", "chrome"]) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* try next */ }
  }
  return chromium.launch({ headless: true });
}

async function openPlayer(browser, timeline) {
  const { width, height } = timeline.video;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.addInitScript((tl) => { window.TIMELINE = tl; window.__RENDER = true; }, timeline);
  await page.goto(pathToFileURL(path.join(ROOT, "player", "index.html")).href);
  await page.waitForFunction(() => window.PLAYER_READY === true);
  return page;
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
  const outDir = path.join(ROOT, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launchBrowser();
  const page = await openPlayer(browser, timeline);

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
    writeWav(wav, synthesize(timeline));
    const mp4 = path.join(outDir, `${id}.mp4`);
    // Render to a temp file and only rename once it passes, so out/ never holds a broken video.
    const tmp = path.join(outDir, `${id}.partial.mp4`);

    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-i", wav,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-t", String(duration), "-movflags", "+faststart",
      "-f", "mp4", tmp,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));

    const started = Date.now();
    for (let f = 0; f < total; f++) {
      await page.evaluate((tt) => window.seek(tt), f / fps);
      const jpg = await page.screenshot({ type: "jpeg", quality: 95 });
      if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
      if (f % fps === 0) process.stdout.write(`\rframe ${f}/${total}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }
    ff.stdin.end();
    await done;
    try { checkVideo(tmp, timeline, duration); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
    fs.renameSync(tmp, mp4);
    console.log(`\nwrote ${path.relative(ROOT, mp4)} (${duration.toFixed(1)}s)`);
    return mp4;
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  await render(positional[0] ?? "pilot", {
    seconds: flags.seconds ? +flags.seconds : undefined,
    frames: flags.frames ? String(flags.frames).split(",").map(Number) : undefined,
  });
}
