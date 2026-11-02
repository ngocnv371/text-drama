// Step 1: write an episode script with Claude.
// Usage: node src/generate.js <episode-id> [--premise "..."]
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { EpisodeSchema, BEATS } from "./schema.js";
import { loadConfig, episodeDir, parseArgs } from "./util.js";

const { positional, flags } = parseArgs(process.argv.slice(2));
const id = positional[0];
if (!id) {
  console.error('usage: node src/generate.js <episode-id> [--premise "..."]');
  process.exit(1);
}

const config = loadConfig();
const dir = episodeDir(id);
const previous = fs.readdirSync(path.dirname(dir), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== id)
  .map((d) => path.join(path.dirname(dir), d.name, "script.json"))
  .filter((f) => fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, "utf8")).title);

// Roughly 2.3s of screen time per message once the director adds typing and holds.
const messageCount = Math.round(config.targetSeconds / 2.3);

const system = `You write viral short-form "text message story" videos. The viewer watches a phone screen as a chat unfolds.

Series topic: ${config.topic}
Tone: ${config.tone}
Audience: ${config.audience}
Language: ${config.language}

Craft rules:
- The hook caption and the first two messages must create a question the viewer needs answered.
- Escalate every few messages. Each message is short (most under 60 characters); a phone screen is small.
- One clear twist near the end, then end on a final line that recontextualises everything.
- Characters text like real people: lowercase, typos only if deliberate, emoji sparingly.
- Tag each message with a beat for the director:
${Object.entries(BEATS).map(([k, v]) => `  - ${k}: ${v}`).join("\n")}
- Use bombshell 2-4 times, never twice in a row. Most messages are normal or rapid.`;

const user = [
  `Write one episode of about ${messageCount} messages (a ${config.targetSeconds}s video).`,
  flags.premise ? `Premise: ${flags.premise}` : "Pick a fresh premise that fits the topic.",
  previous.length ? `Avoid repeating these earlier episodes: ${previous.join("; ")}` : "",
].filter(Boolean).join("\n");

const client = new Anthropic();
console.log(`writing episode "${id}" (${config.model})...`);
const response = await client.messages.parse({
  model: config.model,
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  output_config: { effort: "high", format: zodOutputFormat(EpisodeSchema) },
  system,
  messages: [{ role: "user", content: user }],
});

if (response.stop_reason === "refusal" || !response.parsed_output) {
  console.error(`no script returned (stop_reason: ${response.stop_reason})`);
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, "script.json");
fs.writeFileSync(out, JSON.stringify(response.parsed_output, null, 2));
console.log(`wrote ${path.relative(process.cwd(), out)}: "${response.parsed_output.title}"`);
