// Step 3: render a timeline to mp4. Headless Edge/Chrome captures each frame via seek(t),
// frames are piped straight into ffmpeg, and the synthesised soundtrack is muxed in.
// Usage: node src/render.js <episode-id> [--seconds 10] [--frames 0,12.5,30]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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

export async function render(id, { seconds, frames } = {}) {
  const timeline = writeTimeline(id);
  const dir = episodeDir(id);
  const outDir = path.join(ROOT, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launchBrowser();
  const page = await openPlayer(browser, timeline);

  try {
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

    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-i", wav,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-t", String(duration), "-movflags", "+faststart",
      mp4,
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
    console.log(`\nwrote ${path.relative(ROOT, mp4)} (${duration.toFixed(1)}s)`);
    return mp4;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  await render(positional[0] ?? "pilot", {
    seconds: flags.seconds ? +flags.seconds : undefined,
    frames: flags.frames ? String(flags.frames).split(",").map(Number) : undefined,
  });
}
