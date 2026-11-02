// One command, one finished episode: write the script -> check it -> direct -> render -> check the video.
// Usage: node src/make.js [episode-id] [--premise "..."] [--provider claude|gemini|deepseek]
// Without an id it picks the next free epNN.
import fs from "node:fs";
import path from "node:path";
import { ROOT, parseArgs } from "./util.js";
import { writeEpisode } from "./generate.js";
import { render } from "./render.js";

function nextEpisodeId() {
  const taken = fs.readdirSync(path.join(ROOT, "episodes"))
    .map((name) => /^ep(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => +m[1]);
  return `ep${String(Math.max(0, ...taken) + 1).padStart(2, "0")}`;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const id = positional[0] ?? nextEpisodeId();

try {
  await writeEpisode(id, { premise: flags.premise, provider: flags.provider });
  const mp4 = await render(id);
  console.log(`\ndone: ${path.relative(ROOT, mp4)}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
