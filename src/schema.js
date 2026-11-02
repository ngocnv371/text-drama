import { z } from "zod";

// Beats the director knows how to stage. Keep this list in sync with src/direct.js.
export const BEATS = {
  normal: "default pacing",
  rapid: "fired off right after the previous message, no breath",
  pause: "uncomfortable silence before this message lands",
  fakeout: "sender starts typing, stops, starts again before sending",
  bombshell: "the big reveal: screen shake, flash, bass hit, long hold",
  unsend: "message appears, then the sender unsends it (everyone saw it)",
  leftOnRead: "only for 'me': shows Read receipt, then dead air",
};

export const EpisodeSchema = z.object({
  title: z.string().describe("Internal episode title"),
  hook: z.string().describe("On-screen caption for the first ~3s. First person, max ~10 words, makes people stop scrolling."),
  startClock: z.string().describe("Phone clock at the start, e.g. '11:47 PM'"),
  chat: z.object({
    name: z.string().describe("Contact or group name shown in the header"),
    subtitle: z.string().describe("Small line under the name, e.g. 'manager' or '4 members'"),
  }),
  cast: z.array(z.object({
    id: z.string().describe("Short id. The phone owner MUST be 'me'."),
    name: z.string(),
  })),
  messages: z.array(z.object({
    from: z.string().describe("A cast id"),
    text: z.string(),
    beat: z.enum(Object.keys(BEATS)),
  })),
  cliffhanger: z.string().describe("End card text teasing part 2"),
});
