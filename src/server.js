// Local web view: browse and watch episodes, edit a workspace's series settings, generate new
// episodes, switch between workspaces or create one.
// Usage: npm run web   (then open http://localhost:5180)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream";
import { ROOT, WORKSPACES, loadConfig, loadEnv, loadSettings, listWorkspaces, workspaceDir, episodesDir, outDir } from "./util.js";

const PORT = +(process.env.PORT || 5180);
const PROVIDER_KEYS = { deepseek: ["DEEPSEEK_API_KEY"], gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], claude: ["ANTHROPIC_API_KEY"] };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

loadEnv();

const seriesFile = (ws) => path.join(workspaceDir(ws), "series.json");
const readSeries = (ws) => JSON.parse(fs.readFileSync(seriesFile(ws), "utf8"));

// The workspace a request is about: ?ws=<id>, else the default one.
function requestWorkspace(url) {
  const ws = url.searchParams.get("ws") || loadSettings().defaultWorkspace || listWorkspaces()[0];
  if (!ws || !listWorkspaces().includes(ws)) throw Object.assign(new Error(`No workspace "${ws}".`), { status: 404 });
  return ws;
}

// One job at a time across all workspaces: a batch of new episodes (made one after another)
// or a re-render. The page polls /api/job for progress.
let job = null;

// items: [{ premise, id, state: queued|running|done|failed|skipped, title, error }]
function startJob(kind, ws, items, provider) {
  job = { kind, ws, provider, items, index: -1, running: true, stopRequested: false, lines: [], progress: null, stage: "starting", startedAt: Date.now() };
  runNext(job);
}

function runNext(current) {
  const k = current.items.findIndex((it) => it.state === "queued");
  if (k < 0 || current.stopRequested) {
    for (const it of current.items) if (it.state === "queued") it.state = "skipped";
    current.running = false;
    current.stage = "finished";
    current.progress = null;
    return;
  }
  const item = current.items[k];
  current.index = k;
  current.progress = null;
  current.stage = current.kind === "render" ? "rendering" : "writing";
  item.state = "running";
  const args = current.kind === "render" ? ["src/render.js", item.id] : ["src/make.js"];
  if (current.kind !== "render") {
    if (item.premise) args.push("--premise", item.premise);
    if (current.provider && current.provider !== "config") args.push("--provider", current.provider);
  }
  if (current.items.length > 1) current.lines.push(`=== ${k + 1}/${current.items.length}${item.premise ? `: ${item.premise}` : ""} ===`);

  const proc = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, TEXT_DRAMA_WORKSPACE: current.ws } });
  const errors = [];
  const onData = (buf) => {
    for (const raw of buf.toString().split(/\r|\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const frame = /^frame (\d+)\/(\d+)/.exec(line);
      if (frame) { current.progress = +frame[1] / +frame[2]; current.stage = "rendering"; continue; }
      current.lines.push(line);
      if (current.lines.length > 2000) current.lines.splice(0, current.lines.length - 2000);
      const named = /^\[(ep\d+|[\w-]+)\]/.exec(line);
      if (named && !item.id) item.id = named[1];
      if (/writing script/.test(line)) current.stage = "writing";
      if (/script ok/.test(line)) current.stage = "rendering";
      if (!line.startsWith("[") && !/^(wrote|done:|workspace:)/.test(line)) errors.push(line);
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("close", (code) => {
    item.state = code === 0 ? "done" : "failed";
    if (code !== 0) item.error = errors.slice(-3).join(" ") || `exited with code ${code}`;
    const script = item.id && path.join(episodesDir(current.ws), item.id, "script.json");
    if (script && fs.existsSync(script)) item.title = JSON.parse(fs.readFileSync(script, "utf8")).title;
    runNext(current);
  });
}

function listEpisodes(ws) {
  const root = episodesDir(ws);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "script.json")))
    .map((d) => {
      const dir = path.join(root, d.name);
      const script = JSON.parse(fs.readFileSync(path.join(dir, "script.json"), "utf8"));
      const metaFile = path.join(dir, "meta.json");
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : null;
      const video = path.join(outDir(ws), `${d.name}.mp4`);
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
        seconds: fs.existsSync(path.join(dir, "timeline.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8")).duration : null,
        cliffhanger: script.cliffhanger,
        meta,
        video: hasVideo ? `/video/${ws}/${d.name}.mp4?v=${Math.round(fs.statSync(video).mtimeMs)}` : null,
        updatedAt: (hasVideo ? fs.statSync(video) : fs.statSync(path.join(dir, "script.json"))).mtime,
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function describeWorkspaces() {
  const def = loadSettings().defaultWorkspace;
  return listWorkspaces().map((id) => {
    const s = readSeries(id);
    const dir = episodesDir(id);
    const episodes = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "script.json"))).length : 0;
    return { id, name: s.name ?? id, topic: s.topic, language: s.language, episodes, isDefault: id === def };
  });
}

// A new workspace starts as a copy of another one's settings, with a new name and topic.
function createWorkspace({ id, name, topic, from }) {
  if (!WORKSPACE_ID.test(id ?? "")) throw Object.assign(new Error("Use lowercase letters, digits and dashes for the workspace id, e.g. office-survival."), { status: 400 });
  if (fs.existsSync(path.join(WORKSPACES, id))) throw Object.assign(new Error(`Workspace "${id}" already exists.`), { status: 409 });
  const base = listWorkspaces().includes(from) ? readSeries(from) : readSeries(listWorkspaces()[0]);
  const series = { ...base, name: name?.trim() || id, topic: topic?.trim() || base.topic };
  fs.mkdirSync(path.join(WORKSPACES, id, "episodes"), { recursive: true });
  fs.writeFileSync(seriesFile(id), JSON.stringify(series, null, 2) + "\n");
  return id;
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

// pipeline() closes the file when the browser stops reading (a <video> preview usually reads a
// few kB and hangs up). With .pipe() the handle stayed open, and Windows then refused to let
// the renderer replace that video.
function send(stream, res) {
  pipeline(stream, res, () => {});
}

// Reads bytes start..end and closes the file at once. A browser can sit on a paused <video>
// download indefinitely without hanging up, and a streamed response keeps the file open the
// whole time, which on Windows stops the renderer from replacing that video.
function readRange(file, start, end) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start + 1);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

// <video> needs Range support to seek. Range replies are capped so each is a quick read; the
// browser asks for the next part as it plays.
const RANGE_CAP = 4 * 1024 * 1024;
function sendVideo(req, res, file) {
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (!range) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
    return res.end(readRange(file, 0, size - 1));
  }
  const start = range[1] ? +range[1] : 0;
  const end = Math.min(range[2] ? +range[2] : size - 1, start + RANGE_CAP - 1, size - 1);
  res.writeHead(206, { "content-type": "video/mp4", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  res.end(readRange(file, start, end));
}

function sendStatic(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  send(fs.createReadStream(file), res);
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
    if (p.startsWith("/workspaces/")) return sendStatic(res, safeJoin(WORKSPACES, p.slice(12)) ?? "");
    if (p.startsWith("/video/")) {
      const file = safeJoin(path.join(ROOT, "out"), p.slice(7));
      if (!file || !file.endsWith(".mp4") || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      return sendVideo(req, res, file);
    }

    if (p === "/api/workspaces" && req.method === "GET") return sendJson(res, 200, describeWorkspaces());
    if (p === "/api/workspaces" && req.method === "POST") {
      const id = createWorkspace(await readBody(req));
      return sendJson(res, 201, { id, workspaces: describeWorkspaces() });
    }

    if (p === "/api/episodes" && req.method === "GET") return sendJson(res, 200, listEpisodes(requestWorkspace(url)));

    if (p === "/api/config" && req.method === "GET") {
      const providers = Object.fromEntries(Object.entries(PROVIDER_KEYS).map(([name, keys]) => [name, keys.some((k) => process.env[k])]));
      return sendJson(res, 200, { config: loadConfig(requestWorkspace(url)), providers });
    }
    if (p === "/api/config" && req.method === "PUT") {
      // Only the workspace's own series.json is written; shared settings stay in config/settings.json.
      const ws = requestWorkspace(url);
      const patch = await readBody(req);
      const series = readSeries(ws);
      for (const key of ["name", "topic", "tone", "audience", "language"]) if (typeof patch[key] === "string") series[key] = patch[key];
      if (Number.isFinite(patch.targetSeconds)) series.targetSeconds = Math.min(180, Math.max(15, Math.round(patch.targetSeconds)));
      if (["auto", "deepseek", "gemini", "claude"].includes(patch.provider)) series.llm = { ...series.llm, provider: patch.provider };
      if (["imessage", "workchat"].includes(patch.app)) series.app = patch.app;
      fs.writeFileSync(seriesFile(ws), JSON.stringify(series, null, 2) + "\n");
      return sendJson(res, 200, { config: loadConfig(ws) });
    }

    if (p === "/api/job" && req.method === "GET") return sendJson(res, 200, job && { ...job, lines: job.lines.slice(-200) });

    if (p === "/api/generate" && req.method === "POST") {
      if (job?.running) return sendJson(res, 409, { error: `A job is already running in workspace "${job.ws}".` });
      const ws = requestWorkspace(url);
      const body = await readBody(req);
      // One premise per line; count fills the rest with writer's-choice episodes.
      const premises = String(body.premises ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50);
      const count = Math.min(50, Math.max(premises.length, parseInt(body.count, 10) || 1));
      const items = Array.from({ length: count }, (_, k) => ({ premise: premises[k] ?? null, id: null, state: "queued" }));
      startJob("generate", ws, items, body.provider);
      return sendJson(res, 202, { ok: true });
    }

    if (p === "/api/job/stop" && req.method === "POST") {
      if (!job?.running) return sendJson(res, 409, { error: "Nothing is running." });
      job.stopRequested = true;
      for (const it of job.items) if (it.state === "queued") it.state = "skipped";
      return sendJson(res, 200, { ok: true });
    }

    const rerender = /^\/api\/episodes\/([\w-]+)\/render$/.exec(p);
    if (rerender && req.method === "POST") {
      if (job?.running) return sendJson(res, 409, { error: `A job is already running in workspace "${job.ws}".` });
      const ws = requestWorkspace(url);
      if (!fs.existsSync(path.join(episodesDir(ws), rerender[1], "script.json"))) return sendJson(res, 404, { error: "No such episode." });
      startJob("render", ws, [{ premise: null, id: rerender[1], state: "queued" }]);
      return sendJson(res, 202, { ok: true });
    }

    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    sendJson(res, err.status ?? 500, { error: err.message });
  }
});

// Bind to this machine only: the API can spend your LLM credits.
server.listen(PORT, "127.0.0.1", () => console.log(`text-drama web view: http://localhost:${PORT}`));
