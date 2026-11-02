import { z } from "zod";

// Chat apps the player can draw. The series picks one (config/series.json "app");
// each episode records the app it was written for.
export const APPS = {
  imessage: "a phone text conversation (1:1 or a small group chat)",
  workchat: "a company chat channel like Slack: several coworkers, emoji reactions, people joining or being removed",
};

// Beats the director knows how to stage. Keep this list in sync with src/direct.js.
export const BEATS = {
  normal: "default pacing",
  rapid: "fired off right after the previous message, no breath",
  pause: "uncomfortable silence before this message lands",
  fakeout: "sender starts typing, stops, starts again before sending",
  bombshell: "the big reveal: screen shake, flash, bass hit, long hold",
  unsend: "message appears, then the sender deletes it (everyone saw it)",
  leftOnRead: "imessage only, only for 'me': shows Read receipt, then dead air",
};

export const EpisodeSchema = z.object({
  title: z.string().describe("Internal episode title"),
  logline: z.string().describe("One sentence: the premise and the twist. Used to avoid repeats."),
  hook: z.string().describe("On-screen caption for the first ~3s. First person, max ~10 words, makes people stop scrolling."),
  startClock: z.string().describe("Phone clock at the start, e.g. '11:47 PM'"),
  chat: z.object({
    name: z.string().describe("Contact or group name shown in the header; for workchat a channel like '#marketing'"),
    subtitle: z.string().describe("Small line under the name, e.g. 'manager' or '6 members'"),
  }),
  cast: z.array(z.object({
    id: z.string().describe("Short id. The phone owner MUST be 'me'."),
    name: z.string(),
    role: z.string().describe("Job title shown next to their name in workchat, e.g. 'CEO' or 'Intern'. Can be empty."),
  })),
  messages: z.array(z.object({
    type: z.enum(["message", "system"]).describe("'system' is an app notice, not typed by anyone: joins, removals, channel renames"),
    from: z.string().describe("A cast id. For system notices, the person the notice is about or who did it."),
    text: z.string().describe("The message, or for system notices the full notice, e.g. 'Linda (CEO) joined #marketing' or 'Jack was removed from #marketing by Karen'"),
    beat: z.enum(Object.keys(BEATS)),
    reactions: z.array(z.object({
      emoji: z.string().describe("A single emoji"),
      count: z.number().int().describe("How many people reacted, 1-999"),
    })).describe("Emoji reactions that pile up after the message lands. workchat only; empty for imessage."),
  })),
  cliffhanger: z.string().describe("End card text teasing part 2"),
});

// Older scripts predate type/reactions/role/app; fill in the defaults.
export function normalizeEpisode(script) {
  return {
    ...script,
    app: script.app ?? "imessage",
    cast: script.cast.map((c) => ({ role: "", ...c })),
    messages: script.messages.map((m) => ({ type: "message", reactions: [], ...m })),
  };
}
