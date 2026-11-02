# text-drama

A video pipeline that tells stories as a series of text messages, in vertical 1080×1920 format for TikTok, Reels and Shorts.

```
config/series.json ──► 1. generate ──► episodes/<id>/script.json     (Claude writes it, or you do)
                       2. direct   ──► episodes/<id>/timeline.json   (drama timing)
                       3. render   ──► out/<id>.mp4                   (headless browser + ffmpeg)
```

## Change the topic
Edit `config/series.json`. `topic`, `tone`, `audience` and `targetSeconds` all go into the writer prompt. The default topic is "Gen Z workplace".

## Commands
```bash
npm install
npm run generate -- ep02 --premise "intern accidentally replies-all with their salary"   # needs ANTHROPIC_API_KEY
npm run render -- ep02                      # direct + render to out/ep02.mp4
npm run make -- ep03 --generate             # all three steps
node src/render.js pilot --frames 10,23.5   # PNG stills for a quick look
```
To watch a timeline live, open `player/index.html?ep=pilot` in a browser. Click to restart.

## Script format
`episodes/<id>/script.json` holds a hook caption, the chat header, the cast (the phone owner's id is always `me`), the messages and a cliffhanger. Each message has a **beat** that the director stages:

| beat | what happens on screen |
|---|---|
| `normal` | standard pacing |
| `rapid` | sent right after the previous message |
| `pause` | a long silence first |
| `fakeout` | the typing dots start, stop, then start again |
| `bombshell` | a slow push-in while they type, then a zoom punch, shake, red flash and bass hit |
| `unsend` | the message appears, then becomes "unsent a message" |
| `leftOnRead` | (`me` only) a "Read" receipt, then dead air |

The director finds one pace multiplier that makes the episode land on `targetSeconds`. Edit the gap and hold constants in `src/direct.js` to change the overall feel.

## Notes
- Rendering uses headless Edge (falling back to Chrome), so no window opens. A 60s video takes about 1.5 minutes.
- All audio is synthesised in `src/audio.js`: message sounds, keyboard clicks, bass hits and a tension drone that goes silent just before each bombshell. There are no audio files to license.
- Group chats work too. With more than two cast members, sender names appear above their bubbles.
