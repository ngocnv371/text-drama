// Step 2: turn a script into a timed timeline. All the drama timing lives here.
// Usage: node src/direct.js <episode-id>
import fs from "node:fs";
import path from "node:path";
import { loadConfig, episodeDir, readJson, parseArgs } from "./util.js";
import { normalizeEpisode } from "./schema.js";

const OUTRO_SECONDS = 3.2;
export const HOOK_SECONDS = 3.2;

// Silence before each beat, in seconds at pace 1.
const GAP_BEFORE = { normal: 0.45, rapid: 0.12, pause: 1.7, fakeout: 0.4, bombshell: 0.9, unsend: 0.3, leftOnRead: 0.4 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function direct(script, pace) {
  const messages = [];
  const fx = [];
  let t = 0.35;

  script.messages.forEach((m, i) => {
    const len = [...m.text].length;
    const isMe = m.from === "me";
    if (i > 0) t += GAP_BEFORE[m.beat] * pace;

    const ev = { i, type: m.type, from: m.from, text: m.text, beat: m.beat, typing: [], compose: null };

    if (m.type === "system") {
      // App notices just appear: nobody types them.
      if (m.beat === "bombshell") t += 0.6 * pace;
    } else if (isMe) {
      // The owner types into the compose bar, then hits send.
      const dur = clamp(0.35 + len * 0.028, 0.6, 1.6) * pace * (m.beat === "rapid" ? 0.7 : 1);
      ev.compose = [t, t + dur];
      t += dur;
    } else if (m.beat === "fakeout") {
      // typing... stops... typing again
      const a = 1.1 * pace, gap = 0.9 * pace, b = 0.9 * pace;
      ev.typing.push([t, t + a], [t + a + gap, t + a + gap + b]);
      t += a + gap + b;
    } else {
      let dur = clamp(0.55 + len * 0.022, 0.7, 2.0) * pace;
      if (m.beat === "rapid") dur *= 0.6;
      if (m.beat === "bombshell") dur += 0.6 * pace;
      ev.typing.push([t, t + dur]);
      t += dur;
    }

    ev.appear = t;
    let hold = (0.35 + len * 0.032) * pace;
    if (m.type === "system") fx.push({ type: "system", t });

    // Reactions pile in one after another once people have read it; counts tick up.
    ev.reactions = m.reactions.map((r, k) => ({
      emoji: r.emoji,
      count: r.count,
      at: t + (0.55 + k * 0.38) * pace,
      ramp: Math.min(1.6, 0.25 + Math.log10(Math.max(1, r.count)) * 0.6) * pace,
    }));
    for (const r of ev.reactions) fx.push({ type: "reaction", t: r.at, count: r.count });
    if (ev.reactions.length) hold = Math.max(hold, (0.55 + ev.reactions.length * 0.38) * pace);
    if (m.beat === "bombshell") {
      fx.push({ type: "bombshell", t });
      hold += 1.4 * pace;
    }
    if (m.beat === "leftOnRead") {
      ev.readAt = t + 0.9 * pace;
      hold += 2.2 * pace;
    }
    if (m.beat === "unsend") {
      ev.unsendAt = t + hold + 1.0 * pace;
      fx.push({ type: "unsend", t: ev.unsendAt });
      hold += 1.5 * pace;
    }
    t += hold;
    messages.push(ev);
  });

  return { messages, fx, outroAt: t, duration: t + OUTRO_SECONDS };
}

// Pace 1 is a relaxed read. Faster than MIN_PACE the messages fly by too quickly to read;
// slower than MAX_PACE it drags.
export const MIN_PACE = 0.6;
export const MAX_PACE = 1.3;

// Aim for the target length, but never at the cost of readability: a long script stays
// readable and simply runs longer, a short one runs shorter.
export function directToLength(script, targetSeconds) {
  let lo = 0.4, hi = 2.5;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (direct(script, mid).duration > targetSeconds) hi = mid; else lo = mid;
  }
  const pace = Math.min(MAX_PACE, Math.max(MIN_PACE, (lo + hi) / 2));
  return { pace, ...direct(script, pace) };
}

const clock = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

export function buildTimeline(id) {
  const config = loadConfig();
  const script = normalizeEpisode(readJson(path.join(episodeDir(id), "script.json")));
  const plan = directToLength(script, script.targetSeconds);
  if (Math.abs(plan.duration - script.targetSeconds) > 1) {
    console.log(`[${id}] runs ${clock(plan.duration)} (target ${clock(script.targetSeconds)}) to keep it readable`);
  }
  return {
    id,
    video: config.video,
    theme: config.theme,
    app: script.app,
    hook: script.hook,
    hookSeconds: HOOK_SECONDS,
    cliffhanger: script.cliffhanger,
    startClock: script.startClock,
    chat: script.chat,
    cast: script.cast,
    ...plan,
  };
}

export function writeTimeline(id) {
  const timeline = buildTimeline(id);
  const dir = episodeDir(id);
  fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(timeline, null, 2));
  // Same data as a script tag, so player/index.html works straight from file://
  fs.writeFileSync(path.join(dir, "timeline.js"), `window.TIMELINE = ${JSON.stringify(timeline)};\n`);
  return timeline;
}

if (import.meta.main) {
  const { positional } = parseArgs(process.argv.slice(2));
  const id = positional[0] ?? "pilot";
  const tl = writeTimeline(id);
  console.log(`${id}: ${tl.messages.length} messages, ${tl.duration.toFixed(1)}s at pace ${tl.pace.toFixed(2)}`);
}
