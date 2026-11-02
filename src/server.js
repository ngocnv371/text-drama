// Local web view: browse and watch episodes, edit the series settings, generate new episodes.
// Usage: npm run web   (then open http://localhost:5180)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, loadConfig, loadEnv } from "./util.js";

const PORT = +(process.env.PORT || 5180);
const EPISODES = path.join(ROOT, "episodes");
const OUT = path.join(ROOT, "out");
const CONFIG = path.join(ROOT, "config", "series.json");
const PROVIDER_KEYS = { claude: ["ANTHROPIC_API_KEY"], gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], deepseek: ["DEEPSEEK_API_KEY"] };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

loadEnv();

// One job at a time: generating or re-rendering. The page polls /api/job for progress.
let job = null;

function startJob(kind, args, id) {
  const lines = [];
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
  job = { kind, id, lines, running: true, ok: null, progress: null, stage: "starting", startedAt: Date.now() };
  const current = job;
  const onData = (buf) => {
    for (const raw of buf.toString().split(/\r|\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const frame = /^frame (\d+)\/(\d+)/.exec(line);
      if (frame) { current.progress = +frame[1] / +frame[2]; current.stage = "rendering"; continue; }
      lines.push(line);
      const named = /^\[(ep\d+|[\w-]+)\]/.exec(line);
      if (named && !current.id) current.id = named[1];
      if (/writing script/.test(line)) current.stage = "writing";
      if (/script ok/.test(line)) current.stage = "rendering";
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("close", (code) => {
    current.running = false;
    current.ok = code === 0;
    current.stage = code === 0 ? "done" : "failed";
    if (code === 0) current.progress = 1;
  });
}

function listEpisodes() {
  if (!fs.existsSync(EPISODES)) return [];
  return fs.readdirSync(EPISODES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(EPISODES, d.name, "script.json")))
    .map((d) => {
      const dir = path.join(EPISODES, d.name);
      const script = JSON.parse(fs.readFileSync(path.join(dir, "script.json"), "utf8"));
      const metaFile = path.join(dir, "meta.json");
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : null;
      const video = path.join(OUT, `${d.name}.mp4`);
      const hasVideo = fs.existsSync(video);
      return {
        id: d.name,
        title: script.title,
        app: script.app ?? "imessage",
        hook: script.hook,
        logline: script.logline ?? null,
        chat: script.chat,
        cast: script.cast,
        messages: script.messages,
        cliffhanger: script.cliffhanger,
        meta,
        video: hasVideo ? `/video/${d.name}.mp4?v=${Math.round(fs.statSync(video).mtimeMs)}` : null,
        updatedAt: (hasVideo ? fs.statSync(video) : fs.statSync(path.join(dir, "script.json"))).mtime,
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });
}

// <video> needs Range support to seek.
function sendVideo(req, res, file) {
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (!range) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }
  const start = range[1] ? +range[1] : 0;
  const end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
  res.writeHead(206, { "content-type": "video/mp4", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  fs.createReadStream(file, { start, end }).pipe(res);
}

function sendStatic(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

// Resolve a URL path under a root folder, refusing anything that escapes it.
function safeJoin(root, rel) {
  const file = path.resolve(root, "." + path.posix.normalize("/" + decodeURIComponent(rel)));
  return file.startsWith(root + path.sep) || file === root ? file : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/" || p === "/index.html") return sendStatic(res, path.join(ROOT, "web", "index.html"));
    if (p.startsWith("/web/")) return sendStatic(res, safeJoin(path.join(ROOT, "web"), p.slice(5)) ?? "");
    if (p.startsWith("/player/")) return sendStatic(res, safeJoin(path.join(ROOT, "player"), p.slice(8)) ?? "");
    if (p.startsWith("/episodes/")) return sendStatic(res, safeJoin(EPISODES, p.slice(10)) ?? "");
    if (p.startsWith("/video/")) {
      const file = safeJoin(OUT, p.slice(7));
      if (!file || !file.endsWith(".mp4") || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      return sendVideo(req, res, file);
    }

    if (p === "/api/episodes" && req.method === "GET") return sendJson(res, 200, listEpisodes());

    if (p === "/api/config" && req.method === "GET") {
      const providers = Object.fromEntries(Object.entries(PROVIDER_KEYS).map(([name, keys]) => [name, keys.some((k) => process.env[k])]));
      return sendJson(res, 200, { config: loadConfig(), providers });
    }
    if (p === "/api/config" && req.method === "PUT") {
      const patch = await readBody(req);
      const config = loadConfig();
      for (const key of ["topic", "tone", "audience", "language"]) if (typeof patch[key] === "string") config[key] = patch[key];
      if (Number.isFinite(patch.targetSeconds)) config.targetSeconds = Math.min(180, Math.max(15, Math.round(patch.targetSeconds)));
      if (["auto", "claude", "gemini", "deepseek"].includes(patch.provider)) config.llm.provider = patch.provider;
      if (["imessage", "workchat"].includes(patch.app)) config.app = patch.app;
      fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n");
      return sendJson(res, 200, { config });
    }

    if (p === "/api/job" && req.method === "GET") return sendJson(res, 200, job && { ...job, lines: job.lines.slice(-200) });

    if (p === "/api/generate" && req.method === "POST") {
      if (job?.running) return sendJson(res, 409, { error: "A job is already running." });
      const body = await readBody(req);
      const args = ["src/make.js"];
      if (body.premise?.trim()) args.push("--premise", body.premise.trim());
      if (body.provider && body.provider !== "config") args.push("--provider", body.provider);
      startJob("generate", args, null);
      return sendJson(res, 202, { ok: true });
    }

    const rerender = /^\/api\/episodes\/([\w-]+)\/render$/.exec(p);
    if (rerender && req.method === "POST") {
      if (job?.running) return sendJson(res, 409, { error: "A job is already running." });
      if (!fs.existsSync(path.join(EPISODES, rerender[1], "script.json"))) return sendJson(res, 404, { error: "No such episode." });
      startJob("render", ["src/render.js", rerender[1]], rerender[1]);
      return sendJson(res, 202, { ok: true });
    }

    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// Bind to this machine only: the API can spend your LLM credits.
server.listen(PORT, "127.0.0.1", () => console.log(`text-drama web view: http://localhost:${PORT}`));
