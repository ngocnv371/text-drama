// Step 1: write an episode script with an LLM (Claude, Gemini or DeepSeek, see src/llm.js). Drafts that
// fail src/validate.js go back with the problems listed, so a finished script needs no human read-through.
// Usage: node src/generate.js <episode-id> [--premise "..."] [--provider claude|gemini|deepseek]
import fs from "node:fs";
import path from "node:path";
import { BEATS, APPS } from "./schema.js";
import { validateEpisode } from "./validate.js";
import { pickProvider, draftEpisode } from "./llm.js";
import { loadConfig, loadEnv, episodeDir, parseArgs, ROOT } from "./util.js";

const MAX_ATTEMPTS = 3;

function previousEpisodes(id) {
  const root = path.join(ROOT, "episodes");
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== id)
    .map((d) => path.join(root, d.name, "script.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
    .map((s) => s.logline ? `${s.title}: ${s.logline}` : s.title);
}

// What the writer needs to know about each chat app's format.
const APP_RULES = {
  imessage: `Format: a phone text conversation, 1:1 or a small group chat.
- chat.name is the contact or group name; chat.subtitle is a short descriptor.
- Every message has type "message" and an empty reactions list. Avoid system notices.`,
  workchat: `Format: a company chat channel (think Slack), seen on the phone owner's screen.
- chat.name is a channel like "#marketing" or "#all-hands"; chat.subtitle is like "7 members · Q3 launch".
- 3-6 coworkers in the cast, each with a job title in "role" (CEO, HR, Intern, Team Lead...). Several people post and butt heads; side comments and pile-ons are welcome.
- Use @mentions (e.g. "@maya") to call people out.
- Emoji reactions are part of the story: give at least 3 messages reactions that pile up (e.g. 💀 x 23, 👀 x 9, 🫡 x 4). The count says how the room feels. Use real emoji characters, not names.
- Use system notices (type "system", text written out in full) for the big beats: "Linda (CEO) joined #marketing", "Jack was removed from #marketing by Karen", "Karen renamed the channel to #layoffs". The person it is about goes in "from". At least one notice.
- Never use the leftOnRead beat (there are no read receipts).
- Never name a real chat app or company (no "Slack", "Teams"); say "here", "this channel", "the chat".`,
};

function systemPrompt(config) {
  return `You write viral short-form "text message story" videos. The viewer watches a phone screen as a chat unfolds.

${APP_RULES[config.app]}

Series topic: ${config.topic}
Tone: ${config.tone}
Audience: ${config.audience}
Language: ${config.language}

Craft rules:
- The hook caption (10 words or fewer) and the first two messages must create a question the viewer needs answered.
- Escalate every few messages. Messages are short: most under 60 characters, none over 90. A phone screen is small.
- One clear twist near the end. The final message is a bombshell that recontextualises everything.
- Characters text like real people: lowercase, emoji sparingly in the text itself.
- The phone owner's cast id is "me". Every message's "from" is a cast id.
- Tag each message with a beat for the director:
${Object.entries(BEATS).map(([k, v]) => `  - ${k}: ${v}`).join("\n")}
- Use bombshell 2-4 times, never twice in a row. Most messages are normal or rapid.`;
}

export async function writeEpisode(id, { premise, provider: providerName } = {}) {
  loadEnv();
  const config = loadConfig();
  config.app = APPS[config.app] ? config.app : "imessage";
  const provider = pickProvider(config, providerName);

  // Roughly 2.3s of screen time per message once the director adds typing and holds.
  const messageCount = Math.round(config.targetSeconds / 2.3);
  const previous = previousEpisodes(id);
  const brief = [
    `Write one episode of about ${messageCount} messages (a ${config.targetSeconds}s video).`,
    premise ? `Premise: ${premise}` : "Pick a fresh premise that fits the topic.",
    previous.length ? `Earlier episodes, don't repeat their premise or twist:\n${previous.map((p) => `- ${p}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const dir = episodeDir(id);
  fs.mkdirSync(dir, { recursive: true });

  let draft = null, problems = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const content = draft
      ? `${brief}\n\nYour previous draft:\n${JSON.stringify(draft, null, 2)}\n\nIt failed these checks:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReturn the full corrected episode. Keep what works.`
      : brief;
    console.log(`[${id}] writing script, attempt ${attempt}/${MAX_ATTEMPTS} (${provider.name}: ${provider.model})...`);
    const result = await draftEpisode(provider, { system: systemPrompt(config), user: content });
    if (result.draft) draft = { ...result.draft, app: config.app };
    problems = result.problems.length ? result.problems : validateEpisode(draft, config);
    if (problems.length === 0) {
      const out = path.join(dir, "script.json");
      fs.writeFileSync(out, JSON.stringify(draft, null, 2));
      const meta = { provider: provider.name, model: provider.model, premise: premise ?? null, attempts: attempt, createdAt: new Date().toISOString() };
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
      console.log(`[${id}] script ok: "${draft.title}"`);
      return draft;
    }
    console.log(`[${id}] draft failed ${problems.length} check(s):\n  - ${problems.join("\n  - ")}`);
  }

  if (draft) fs.writeFileSync(path.join(dir, "script.rejected.json"), JSON.stringify(draft, null, 2));
  throw new Error(`[${id}] no script passed the checks after ${MAX_ATTEMPTS} attempts:\n  - ${problems.join("\n  - ")}`);
}

if (import.meta.main) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (!positional[0]) {
    console.error('usage: node src/generate.js <episode-id> [--premise "..."]');
    process.exit(1);
  }
  try {
    await writeEpisode(positional[0], { premise: flags.premise, provider: flags.provider });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
