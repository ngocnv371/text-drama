// One command, finished episodes: write the script -> check it -> direct -> render -> check the video.
// Usage: node src/make.js [episode-id] [--premise "..."] [--provider claude|gemini|deepseek]
//        node src/make.js --count 5 [--premises premises.txt]   (a batch, one episode at a time)
// Without an id it picks the next free epNN. In a batch, a failed episode is reported and
// the batch moves on; each new episode sees the earlier ones, so premises don't repeat.
import fs from "node:fs";
import path from "node:path";
import { ROOT, parseArgs } from "./util.js";
import { writeEpisode } from "./generate.js";
import { render } from "./render.js";

function nextEpisodeId() {
  const taken = fs.readdirSync(path.join(ROOT, "episodes"))
    .filter((name) => fs.existsSync(path.join(ROOT, "episodes", name, "script.json")))
    .map((name) => /^ep(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => +m[1]);
  return `ep${String(Math.max(0, ...taken) + 1).padStart(2, "0")}`;
}

async function makeOne(id, premise, provider) {
  await writeEpisode(id, { premise, provider });
  const mp4 = await render(id);
  console.log(`\ndone: ${path.relative(ROOT, mp4)}`);
  return mp4;
}

const { positional, flags } = parseArgs(process.argv.slice(2));

// The batch: premises from a file (one per line) and/or --count; missing premises are left to the writer.
const premises = flags.premises
  ? fs.readFileSync(flags.premises, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  : flags.premise ? [flags.premise] : [];
const count = Math.max(premises.length, flags.count ? parseInt(flags.count, 10) || 1 : 1);

if (count === 1) {
  try {
    await makeOne(positional[0] ?? nextEpisodeId(), premises[0], flags.provider);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else {
  if (positional[0]) console.warn(`ignoring episode id "${positional[0]}": batches always use the next free epNN`);
  const results = [];
  for (let k = 0; k < count; k++) {
    const id = nextEpisodeId();
    console.log(`\n=== batch ${k + 1}/${count}: ${id}${premises[k] ? ` (${premises[k]})` : ""} ===`);
    try {
      const mp4 = await makeOne(id, premises[k], flags.provider);
      results.push({ id, ok: true, detail: path.relative(ROOT, mp4) });
    } catch (err) {
      console.error(err.message);
      results.push({ id, ok: false, detail: err.message.split("\n")[0] });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nbatch finished: ${count - failed}/${count} episodes made`);
  for (const r of results) console.log(`  ${r.ok ? "ok    " : "FAILED"} ${r.id}  ${r.detail}`);
  if (failed) process.exit(1);
}
