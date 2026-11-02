// Automatic checks that stand in for a human read-through. Each problem is phrased as an
// instruction the writer can act on, because failed scripts go straight back to Claude.
import { BEATS } from "./schema.js";
import { directToLength } from "./direct.js";

const MAX_CHARS = 90;          // longer than this and a bubble eats the screen
const MIN_PACE = 0.55;         // below this the video is a blur
const MAX_PACE = 1.4;          // above this it drags

export function validateEpisode(script, config) {
  const problems = [];
  const ids = new Set((script.cast ?? []).map((c) => c.id));
  const msgs = script.messages ?? [];

  if (!ids.has("me")) problems.push(`The cast must include the phone owner with id "me".`);
  if (ids.size < 2) problems.push("The cast needs at least two people.");
  if (!script.hook?.trim()) problems.push("The hook caption is empty.");
  else if (script.hook.split(/\s+/).length > 12) problems.push(`The hook is ${script.hook.split(/\s+/).length} words; keep it to 10 or fewer.`);
  if (!script.cliffhanger?.trim()) problems.push("The cliffhanger is empty.");
  if (!/^\d{1,2}:\d{2}(\s?(AM|PM))?$/i.test(script.startClock ?? "")) problems.push(`startClock "${script.startClock}" must look like "11:47 PM".`);

  msgs.forEach((m, i) => {
    const n = i + 1;
    if (!ids.has(m.from)) problems.push(`Message ${n} is from "${m.from}", which is not a cast id.`);
    if (!(m.beat in BEATS)) problems.push(`Message ${n} has unknown beat "${m.beat}".`);
    if (!m.text?.trim()) problems.push(`Message ${n} is empty.`);
    else if ([...m.text].length > MAX_CHARS) problems.push(`Message ${n} is ${[...m.text].length} characters; split or trim it to ${MAX_CHARS} or fewer.`);
    if (m.beat === "leftOnRead" && m.from !== "me") problems.push(`Message ${n} uses leftOnRead but is not from "me".`);
    if (m.beat === "bombshell" && msgs[i - 1]?.beat === "bombshell") problems.push(`Messages ${n - 1} and ${n} are both bombshells; separate them.`);
  });
  if (msgs[0] && ["leftOnRead", "unsend"].includes(msgs[0].beat)) problems.push("The first message can't be leftOnRead or unsend.");

  const bombs = msgs.filter((m) => m.beat === "bombshell").length;
  if (bombs < 2 || bombs > 4) problems.push(`There are ${bombs} bombshells; use 2 to 4.`);
  if (msgs.at(-1) && msgs.at(-1).beat !== "bombshell") problems.push("End on the final reveal: make the last message a bombshell.");
  const speakers = new Set(msgs.map((m) => m.from));
  if (!speakers.has("me") || speakers.size < 2) problems.push("Both the owner and at least one other person must send messages.");

  // Length: only meaningful once the structure is sound.
  if (problems.length === 0) {
    const { pace } = directToLength(script, config.targetSeconds);
    if (pace < MIN_PACE) problems.push(`The script is too long for ${config.targetSeconds}s. Cut about ${Math.ceil(msgs.length * (1 - pace / 0.7))} messages.`);
    if (pace > MAX_PACE) problems.push(`The script is too short for ${config.targetSeconds}s. Add about ${Math.ceil(msgs.length * (pace / 0.7 - 1))} messages.`);
  }
  return problems;
}
