// Automatic checks that stand in for a human read-through. Each problem is phrased as an
// instruction the writer can act on, because failed scripts go straight back to the LLM.
import { BEATS, APPS, normalizeEpisode, bombshellRange, limitsFor } from "./schema.js";
import { directToLength, HOOK_SECONDS } from "./direct.js";

const SYSTEM_BEATS = ["normal", "rapid", "pause", "bombshell"];
const ENGLISH_NOTICE = /\b(joined|left|removed|renamed|was added|added to|was kicked)\b/i;

export function validateEpisode(raw, config) {
  const problems = [];
  const script = normalizeEpisode(raw);
  const app = script.app;
  const ids = new Set(script.cast.map((c) => c.id));
  const msgs = script.messages;
  const posts = msgs.filter((m) => m.type === "message");
  const { hookWords, messageChars } = limitsFor(config);

  if (!(app in APPS)) problems.push(`Unknown app "${app}".`);
  if (!ids.has("me")) problems.push(`The cast must include the phone owner with id "me".`);
  if (ids.size < 2) problems.push("The cast needs at least two people.");
  if (app === "workchat" && ids.size < 3) problems.push("A workchat channel needs at least 3 people in the cast; more voices means more conflict.");
  if (!script.hook?.trim()) problems.push("The hook caption is empty.");
  else if (script.hook.split(/\s+/).length > hookWords + 2) problems.push(`The hook is ${script.hook.split(/\s+/).length} words; keep it to ${hookWords} or fewer.`);
  if (!script.cliffhanger?.trim()) problems.push("The cliffhanger is empty.");
  if (!/^\d{1,2}:\d{2}(\s?(AM|PM))?$/i.test(script.startClock ?? "")) problems.push(`startClock "${script.startClock}" must look like "11:47 PM" or "23:47".`);

  msgs.forEach((m, i) => {
    const n = i + 1;
    if (!ids.has(m.from)) problems.push(`Message ${n} is from "${m.from}", which is not a cast id.`);
    if (!(m.beat in BEATS)) problems.push(`Message ${n} has unknown beat "${m.beat}".`);
    if (!m.text?.trim()) problems.push(`Message ${n} is empty.`);
    else if ([...m.text].length > messageChars) problems.push(`Message ${n} is ${[...m.text].length} characters; split or trim it to ${messageChars} or fewer.`);
    if (m.beat === "leftOnRead" && (m.from !== "me" || app !== "imessage")) problems.push(`Message ${n} uses leftOnRead, which only works on "me" messages in imessage.`);
    if (m.beat === "bombshell" && msgs[i - 1]?.beat === "bombshell") problems.push(`Messages ${n - 1} and ${n} are both bombshells; separate them.`);
    // The workchat skin is unbranded, so its dialogue mustn't name the app it imitates.
    if (app === "workchat" && /\b(slack|microsoft teams|discord|whatsapp|imessage|zalo|messenger)\b/i.test(m.text ?? "")) problems.push(`Message ${n} names a real app; say "here" or "this channel" instead.`);
    if (m.type === "system" && !/^english/i.test(config.language ?? "English") && ENGLISH_NOTICE.test(m.text ?? "")) {
      problems.push(`System notice ${n} ("${m.text}") is in English; write it in the series language${config.systemNoticeExamples?.[0] ? `, like "${config.systemNoticeExamples[0]}"` : ""}.`);
    }
    if (m.type === "system" && !SYSTEM_BEATS.includes(m.beat)) problems.push(`Message ${n} is a system notice; give it one of these beats: ${SYSTEM_BEATS.join(", ")}.`);
    if (m.reactions.length && app !== "workchat") problems.push(`Message ${n} has reactions, but reactions only exist in workchat. Leave them empty.`);
    if (m.reactions.length > 4) problems.push(`Message ${n} has ${m.reactions.length} reactions; use at most 4.`);
    for (const r of m.reactions) {
      if (!r.emoji?.trim() || [...r.emoji].length > 8 || /[a-z0-9:]/i.test(r.emoji)) problems.push(`Message ${n} has reaction "${r.emoji}"; use a single emoji character, not a name.`);
      if (!Number.isInteger(r.count) || r.count < 1 || r.count > 999) problems.push(`Message ${n} has a reaction count of ${r.count}; use 1-999.`);
    }
  });
  if (msgs[0] && ["leftOnRead", "unsend"].includes(msgs[0].beat)) problems.push("The first message can't be leftOnRead or unsend.");

  const bombs = msgs.filter((m) => m.beat === "bombshell").length;
  // Scripts may run longer than the target, and a longer one earns more big moments
  // (about 2.3s of screen time per message).
  const [minBombs, maxBombs] = bombshellRange(Math.max(script.targetSeconds, msgs.length * 2.3));
  if (bombs < minBombs || bombs > maxBombs) problems.push(`There are ${bombs} bombshells; use ${minBombs} to ${maxBombs}.`);
  if (msgs.at(-1) && msgs.at(-1).beat !== "bombshell") problems.push("End on the final reveal: make the last message a bombshell.");
  const speakers = new Set(posts.map((m) => m.from));
  if (!speakers.has("me") || speakers.size < 2) problems.push("Both the owner and at least one other person must send messages.");

  if (app === "workchat") {
    if (speakers.size < 3) problems.push("In workchat at least 3 people must post; let them butt heads.");
    if (!msgs.some((m) => m.type === "system")) problems.push("Add at least one system notice (someone joining, leaving or being removed from the channel).");
    if (msgs.filter((m) => m.reactions.length).length < 3) problems.push("Give at least 3 messages emoji reactions; the pile-on is part of the drama.");
  }

  // Pacing: only meaningful once the structure is sound. Length is not checked: the target is
  // a guide, and the director lets a long or short script run at whatever length reads well.
  if (problems.length === 0) problems.push(...deadStretches(script, directToLength(script, script.targetSeconds)));
  return problems;
}

const MAX_DEAD_AIR = 20;   // seconds without a jolt before viewers swipe away
const clock = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

// A jolt is anything that visibly shakes up the screen. The hook caption covers the opening.
function deadStretches(script, plan) {
  const jolts = plan.messages
    .filter((ev, i) => {
      const m = script.messages[i];
      return m.beat === "bombshell" || m.beat === "unsend" || m.type === "system" || m.reactions.length > 0;
    })
    .map((ev) => ev.appear);
  const marks = [HOOK_SECONDS, ...jolts, plan.outroAt];
  const problems = [];
  for (let k = 1; k < marks.length; k++) {
    const gap = marks[k] - marks[k - 1];
    if (gap > MAX_DEAD_AIR) {
      problems.push(`Between ${clock(marks[k - 1])} and ${clock(marks[k])} nothing big happens (${Math.round(gap)}s). Add a jolt around ${clock((marks[k - 1] + marks[k]) / 2)}: a reveal (bombshell), a deleted message, someone joining or being removed, or a reaction pile-on.`);
    }
  }
  return problems;
}
