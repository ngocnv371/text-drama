// Whole pipeline: [generate ->] direct -> render.
// Usage: node src/make.js <episode-id> [--generate] [--premise "..."]
import { spawnSync } from "node:child_process";
import { parseArgs } from "./util.js";
import { render } from "./render.js";

const { positional, flags } = parseArgs(process.argv.slice(2));
const id = positional[0] ?? "pilot";

if (flags.generate) {
  const args = ["src/generate.js", id, ...(flags.premise ? ["--premise", flags.premise] : [])];
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
await render(id);
