# text-drama

A video pipeline that tells stories as a series of text messages, in vertical 1080×1920 format for TikTok, Reels and Shorts.

## Make a new episode
One-time setup: run `npm install`, and have an API key for at least one of these providers:

| provider | key (environment variable or `.env`) | default model |
|---|---|---|
| `claude` | `ANTHROPIC_API_KEY` | `claude-opus-5-5` |
| `gemini` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-3.1-pro-preview` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |

Then, for each episode:
```bash
npm run generate
```
That writes the script, checks it, times the drama, renders the video and checks the result. The finished video lands in `out/epNN.mp4`. Optional extras: `npm run generate -- --premise "intern replies-all with their salary"`, or give an id with `npm run generate -- ep07`.

**Choosing the provider:** set `llm.provider` in `config/series.json` to `claude`, `gemini` or `deepseek`. The default, `auto`, uses the first provider that has a key, in the table's order. You can also override it for one run with `npm run generate -- --provider deepseek`. The model names are in the same `llm` block.

You don't need to read the script first. Every draft goes through automatic checks ([src/validate.js](src/validate.js)), and a draft that fails goes back to the writer with the problems listed, up to 3 attempts. The checks cover:
- **structure:** a valid cast, `me` exists, every sender is in the cast, beats are used correctly
- **drama:** 2–4 bombshells, never two in a row, ending on a bombshell, a hook of 10 words or fewer
- **readability:** no message over 90 characters
- **length:** the script fits the target duration at a watchable pace

After rendering, it also checks the layout (no bubble or caption that swamps the screen) and the video file (size, duration, audio track). If anything still fails, the command exits with an error that says why, and nothing half-done is left in `out/`.

## Change the topic
Edit `config/series.json`. `topic`, `tone`, `audience` and `targetSeconds` all go into the writer prompt. New episodes avoid the premises of earlier ones.

## Pipeline
```
config/series.json ──► 1. script  ──► episodes/<id>/script.json     (Claude/Gemini/DeepSeek, checked + auto-revised)
                       2. direct  ──► episodes/<id>/timeline.json   (drama timing)
                       3. render  ──► out/<id>.mp4                   (headless browser + ffmpeg, checked)
```
Run a single step:
```bash
npm run script -- ep02      # script only
npm run render -- ep02      # re-render after editing a script by hand
node src/render.js pilot --frames 10,23.5   # PNG stills
```
To watch a timeline live, open `player/index.html?ep=pilot` in a browser.

## Beats
Each message has a beat that the director stages:

| beat | what happens on screen |
|---|---|
| `normal` | standard pacing |
| `rapid` | sent right after the previous message |
| `pause` | a long silence first |
| `fakeout` | the typing dots start, stop, then start again |
| `bombshell` | a slow push-in while they type, then a zoom punch, shake, red flash and bass hit |
| `unsend` | the message appears, then becomes "unsent a message" |
| `leftOnRead` | (`me` only) a "Read" receipt, then dead air |

## Notes
- Rendering uses headless Edge (falling back to Chrome), so no window opens. A 60s video takes about 1.5 minutes.
- All audio is synthesised in `src/audio.js`, so there are no files to license.
- Group chats work: with more than two cast members, sender names appear above their bubbles.
