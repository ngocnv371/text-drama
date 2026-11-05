# text-drama

A video pipeline that tells stories as a series of text messages, in vertical 1080×1920 format for TikTok, Reels and Shorts.

## Workspaces
A workspace is a separate series with the same mechanics: its own topic, tone, language, chat app, length, writer settings, episodes and videos. Two come with the project:

| workspace | series |
|---|---|
| `genz-workplace` (default) | Gen Z Workplace, in English |
| `sinh-ton-noi-cong-so` | Sinh Tồn Nơi Công Sở, Vietnamese office life, in Vietnamese |

```
workspaces/<id>/series.json        the series' settings
workspaces/<id>/episodes/<epNN>/   its scripts and timelines
workspaces/<id>/music/             optional: its own tracks (otherwise assets/music is used)
out/<id>/<epNN>.mp4                its videos
config/settings.json               shared: default workspace, render pool, music volume
```

Every command takes `--workspace <id>` (otherwise the default from `config/settings.json` is used):
```bash
npm run generate -- --workspace sinh-ton-noi-cong-so
npm run render -- ep01 --workspace sinh-ton-noi-cong-so
```
In the web view, pick a workspace from the dropdown at the top, or choose **+ New workspace…**. A new workspace starts with a copy of the current one's settings, so you only change what's different.

**Other languages:** set `language` and the writer writes everything the viewer reads in it. The `ui` block translates the app's own labels ("Delivered", "is typing", "follow for part 2"…), `systemNoticeExamples` shows the writer how notices like "X joined #channel" read in that language, and `limits` (`hookWords`, `messageChars`) allows for languages that need more room. See `workspaces/sinh-ton-noi-cong-so/series.json` for a full example. In a non-English series, a draft with English system notices is sent back to the writer.

## Make a new episode
One-time setup: run `npm install`, and have an API key for at least one of these providers:

| provider | key (environment variable or `.env`) | default model |
|---|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| `gemini` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-3.1-pro-preview` |
| `claude` | `ANTHROPIC_API_KEY` (a global `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` is ignored) | `claude-opus-5-5` |

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

**Choosing the provider:** set `llm.provider` in the workspace's `series.json` to `deepseek`, `gemini` or `claude`. The default, `auto`, uses the first provider that has a key, in the table's order (DeepSeek, then Gemini, then Claude). You can also override it for one run with `npm run generate -- --provider deepseek`. The model names are in the same `llm` block. `llm.deepseekEffort` (`low`, `high` or `max`, default `low`) sets how long DeepSeek reasons before writing. Most of a call is spent reasoning: at `high`, deepseek-v4-pro took about 5.5 minutes per call, and `low` roughly halves that. For much faster writing, switch the model to `deepseek-flash` (about 40s per call).

You don't need to read the script first. Every draft goes through automatic checks ([src/validate.js](src/validate.js)), and a draft that fails goes back to the writer with the problems listed, up to 3 attempts. The checks cover:
- **structure:** a valid cast, `me` exists, every sender is in the cast, beats are used correctly
- **drama:** 2–4 bombshells, never two in a row, ending on a bombshell, a hook of 10 words or fewer
- **readability:** no message over 90 characters
- **pacing:** never more than 20 seconds without a jolt (a reveal, a deleted message, someone joining or being removed, or a reaction pile-on). The writer gets the exact timestamps to fix.

After rendering, it also checks the layout (no bubble or caption that swamps the screen) and the video file (size, duration, audio track). If anything still fails, the command exits with an error that says why, and nothing half-done is left in `out/`.

## Chat apps
Set `app` in the workspace's `series.json`, or use the web view's settings. Each episode remembers the app it was written for.

- **`workchat`** (default): a company channel styled like a workplace chat app, with no real brand. Several coworkers with job titles argue in it, `@mentions` are highlighted (a mention of the phone owner lights up the whole row), and emoji reactions pop in with counts that tick up. System notices such as "Linda (CEO) joined #marketing" or "Jack was removed from #marketing by Karen" appear, removals in red. Whoever is typing shows as "Derek is typing…" above the message box.
- **`imessage`**: phone texts with bubbles, typing dots and Read receipts.

The checks are stricter for work chat: at least 3 people post, at least one system notice, at least 3 messages with reactions, and no real app names in the dialogue.

## Change the topic or length
Edit the workspace's `series.json`, or use the web view's Series settings. `topic`, `tone`, `audience`, `language` and `targetSeconds` all go into the writer prompt. The default length is 90 seconds. That's a target, not a limit: every script plays at a readable pace, so a long script makes a longer video and a short one a shorter video. Videos of 75 seconds or more get a three-act structure with a midpoint twist, and the number of bombshells allowed grows with the length. Each episode remembers the length it was written for, so re-rendering an old one doesn't stretch it. New episodes avoid the premises of earlier ones.

## Pipeline
```
series.json        ──► 1. script  ──► episodes/<id>/script.json     (DeepSeek/Gemini/Claude, checked + auto-revised)
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
- **Rendering** uses headless Edge (falling back to Chrome), so no window opens. Several browsers capture frames in parallel and the video is encoded on the GPU when one is available (AMD AMF, then NVIDIA NVENC, then Intel Quick Sync, otherwise the CPU). A 90s episode takes about 30 seconds. Tune it under `render` in `config/settings.json`: `browsers`, `tabsPerBrowser`, and `encoder` (`auto`, `h264_amf`, `h264_nvenc`, `h264_qsv` or `libx264`). One browser tops out around 60 frames per second however many tabs it has, so more browsers is what scales.
- **Sound:** message sounds, keyboard clicks, reaction pops and bass hits are synthesised in `src/audio.js`. Under them runs a quiet ambience track from `assets/music/`, picked at random for each episode, never the same as the previous episode's, and kept for re-renders (it's saved in the episode's `meta.json`). Every track is brought to the same level (`music.volumeDb` in `config/settings.json`, default -30, so lower is quieter). It drops almost to silence right before each bombshell, loops with a crossfade if the video runs longer than the track, and fades out at the end. Everything below 80 Hz is filtered out of the music, because sustained sub-bass reads as a hum on phone speakers.
- **More music:** the tracks were made locally with comfy-helper (ACE-Step). Add any mp3, flac, opus or wav to `assets/music/` and it joins the rotation. For example:
  ```bash
  node ../comfy-helper/comfy-music.mjs --prompt "quiet lofi office background, no vocals, instrumental" --duration 150 --out assets/music/my-track.mp3
  ```
- In imessage group chats (more than two cast members), sender names appear above the bubbles.
