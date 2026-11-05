import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKSPACES = path.join(ROOT, "workspaces");
const SETTINGS = path.join(ROOT, "config", "settings.json");

// A workspace is one series: its own topic, tone, language, chat app and writer settings
// (workspaces/<name>/series.json) and its own episodes. Settings shared by every workspace
// (render pool, music volume, the default workspace) live in config/settings.json.
export function loadSettings() {
  return fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, "utf8")) : {};
}

export function listWorkspaces() {
  if (!fs.existsSync(WORKSPACES)) return [];
  return fs.readdirSync(WORKSPACES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(WORKSPACES, d.name, "series.json")))
    .map((d) => d.name)
    .sort();
}

// --workspace <name> on the command line, else TEXT_DRAMA_WORKSPACE (set by the web view for
// the jobs it starts), else the default from config/settings.json.
export function currentWorkspace() {
  const i = process.argv.indexOf("--workspace");
  const name = (i > 0 && process.argv[i + 1]) || process.env.TEXT_DRAMA_WORKSPACE || loadSettings().defaultWorkspace || listWorkspaces()[0];
  if (!name || !fs.existsSync(path.join(WORKSPACES, name, "series.json"))) {
    throw new Error(`No workspace "${name}". Workspaces: ${listWorkspaces().join(", ") || "none"}.`);
  }
  return name;
}

export const workspaceDir = (ws = currentWorkspace()) => path.join(WORKSPACES, ws);
export const episodesDir = (ws = currentWorkspace()) => path.join(workspaceDir(ws), "episodes");
export const episodeDir = (id, ws = currentWorkspace()) => path.join(episodesDir(ws), id);
export const outDir = (ws = currentWorkspace()) => path.join(ROOT, "out", ws);

// The workspace's series settings on top of the shared ones.
export function loadConfig(ws = currentWorkspace()) {
  const { defaultWorkspace, ...shared } = loadSettings();
  const series = JSON.parse(fs.readFileSync(path.join(workspaceDir(ws), "series.json"), "utf8"));
  return { ...shared, ...series, workspace: ws };
}

// Pick up API keys from .env without overriding a key already in the environment.
export function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// "--premise foo --generate" -> { positional: [...], flags: { premise: "foo", generate: true } }
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { positional, flags };
}
