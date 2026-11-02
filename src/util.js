import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "config", "series.json"), "utf8"));
}

// Pick up ANTHROPIC_API_KEY from .env without overriding a key already in the environment.
export function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function episodeDir(id) {
  return path.join(ROOT, "episodes", id);
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
