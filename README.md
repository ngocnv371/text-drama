# text-drama

A video pipeline that tells stories as a series of text messages, in vertical 1080×1920 format for TikTok, Reels and Shorts.

## Make a new episode
One-time setup: run `npm install`, and have an API key for at least one of these providers:

| provider | key (environment variable or `.env`) | default model |
|---|---|---|
| `claude` | `ANTHROPIC_API_KEY` (a global `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` is ignored) | `claude-opus-5-5` |
| `gemini` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-3.1-pro-preview` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |

Then, for each episode:
```bash
npm run generate
```
That writes the script, checks it, times the drama, renders the video and checks the result. The finished video lands in `out/epNN.mp4`. Optional extras: `npm run generate -- --premise "intern replies-all with their salary"`, or give an id with `npm run generate -- ep07`.

**Batches:** make several episodes in one go. They run one at a time until all are done, and each new episode sees the ones before it, so premises don't repeat. If one fails, the batch carries on with the next and lists what failed at the end.
```bash
npm run generate -- --count 5                      # 5 episodes, the writer picks each premise
npm run generate -- --premises ideas.txt           # one episode per line of ideas.txt
npm run generate -- --premises ideas.txt --count 8 # the lines first, then writer's choice up to 8
```

**Or use the web view:**
```bash
npm run web
```
Then open http://localhost:5180. From the page you can watch every episode and read its script with the beats marked, generate one episode or a batch (set "How many", or type one premise per line) and watch a queue that shows each episode's status, with **Stop after this one** to end a batch early, re-render or download an episode, and change the series topic, tone, length and default writer. The page is only reachable from this computer.

**Choosing the provider:** set `llm.provider` in `config/series.json` to `claude`, `gemini` or `deepseek`. The default, `auto`, uses the first provider that has a key, in the table's order. You can also override it for one run with `npm run generate -- --provider deepseek`. The model names are in the same `llm` block.

You don't need to read the script first. Every draft goes through automatic checks ([src/validate.js](src/validate.js)), and a draft that fails goes back to the writer with the problems listed, up to 3 attempts. The checks cover:
- **structure:** a valid cast, `me` exists, every sender is in the cast, beats are used correctly
- **drama:** 2–4 bombshells, never two in a row, ending on a bombshell, a hook of 10 words or fewer
- **readability:** no message over 90 characters
- **pacing:** never more than 20 seconds without a jolt (a reveal, a deleted message, someone joining or being removed, or a reaction pile-on). The writer gets the exact timestamps to fix.

After rendering, it also checks the layout (no bubble or caption that swamps the screen) and the video file (size, duration, audio track). If anything still fails, the command exits with an error that says why, and nothing half-done is left in `out/`.

## Chat apps
Set `app` in `config/series.json`, or use the web view's settings. Each episode remembers the app it was written for.

- **`workchat`** (default): a company channel styled like a workplace chat app, with no real brand. Several coworkers with job titles argue in it, `@mentions` are highlighted (a mention of the phone owner lights up the whole row), and emoji reactions pop in with counts that tick up. System notices such as "Linda (CEO) joined #marketing" or "Jack was removed from #marketing by Karen" appear, removals in red. Whoever is typing shows as "Derek is typing…" above the message box.
- **`imessage`**: phone texts with bubbles, typing dots and Read receipts.

The checks are stricter for work chat: at least 3 people post, at least one system notice, at least 3 messages with reactions, and no real app names in the dialogue.

## Change the topic or length
Edit `config/series.json`. `topic`, `tone`, `audience` and `targetSeconds` all go into the writer prompt. The default length is 90 seconds. That's a target, not a limit: every script plays at a readable pace, so a long script makes a longer video and a short one a shorter video. Videos of 75 seconds or more get a three-act structure with a midpoint twist, and the number of bombshells allowed grows with the length. Each episode remembers the length it was written for, so re-rendering an old one doesn't stretch it. New episodes avoid the premises of earlier ones.

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
| `unsend` | the message appears, then becomes "unsent a message" (work chat: "This message was deleted.") |
| `leftOnRead` | (`me` only, imessage only) a "Read" receipt, then dead air |

## Notes
- Rendering uses headless Edge (falling back to Chrome), so no window opens. A 60s video takes about 1.5 minutes.
- All audio is synthesised in `src/audio.js`, so there are no files to license.
- In imessage group chats (more than two cast members), sender names appear above the bubbles.
