// The script writer behind one interface: draftEpisode() returns { draft, problems }.
// Which provider runs is set by llm.provider in config/series.json, or --provider on the command line.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI, ApiError as GeminiApiError } from "@google/genai";
import { z } from "zod";
import { EpisodeSchema } from "./schema.js";

// In "auto" mode the first provider with a key wins, in this order.
const PROVIDERS = {
  deepseek: { keys: ["DEEPSEEK_API_KEY"], draft: draftWithDeepSeek },
  gemini: { keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], draft: draftWithGemini },
  // Only a real API key counts: ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL are often set
  // globally for other tools (e.g. pointing at a local model server).
  claude: { keys: ["ANTHROPIC_API_KEY"], draft: draftWithClaude },
};

const keyFor = (name) => PROVIDERS[name].keys.map((k) => process.env[k]).find(Boolean);

export function pickProvider(config, override) {
  const wanted = override ?? config.llm.provider ?? "auto";
  if (wanted === "auto") {
    const name = Object.keys(PROVIDERS).find(keyFor);
    if (!name) throw new Error(`No API key found. Set one of ${Object.values(PROVIDERS).map((p) => p.keys[0]).join(", ")} (environment or .env).`);
    return { name, model: config.llm[name] };
  }
  if (!PROVIDERS[wanted]) throw new Error(`unknown provider "${wanted}" (use auto, ${Object.keys(PROVIDERS).join(", ")})`);
  if (!keyFor(wanted)) throw new Error(`provider is "${wanted}" but ${PROVIDERS[wanted].keys[0]} is not set (environment or .env).`);
  return { name: wanted, model: config.llm[wanted] };
}

export async function draftEpisode(provider, { system, user }) {
  try {
    return await PROVIDERS[provider.name].draft(provider.model, system, user, keyFor(provider.name));
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
    if (err instanceof GeminiApiError && [400, 401, 403].includes(err.status) && /key/i.test(err.message)) throw new Error("The Gemini API key was rejected. Check GEMINI_API_KEY.");
    throw err;
  }
}

// Shared by the providers that return raw JSON text instead of a parsed object.
function parseDraft(text, reason) {
  let json;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    return { draft: null, problems: [`the reply was not valid JSON (finish reason: ${reason})`] };
  }
  const parsed = EpisodeSchema.safeParse(json);
  if (!parsed.success) {
    return { draft: json, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "episode"}: ${i.message}`) };
  }
  return { draft: parsed.data, problems: [] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function draftWithClaude(model, system, user, apiKey) {
  // Explicit key and URL so a global ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL can't redirect the call.
  const client = new Anthropic({ apiKey, authToken: null, baseURL: process.env.TEXT_DRAMA_ANTHROPIC_BASE_URL || "https://api.anthropic.com", maxRetries: 4 });
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(EpisodeSchema) },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    return { draft: null, problems: [`no usable script returned (stop_reason: ${response.stop_reason})`] };
  }
  return { draft: response.parsed_output, problems: [] };
}

const { $schema, ...episodeJsonSchema } = z.toJSONSchema(EpisodeSchema);

async function draftWithGemini(model, system, user, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  let response;
  // The SDK doesn't retry on its own; ride out rate limits and overloads.
  for (let attempt = 1; ; attempt++) {
    try {
      response = await ai.models.generateContent({
        model,
        contents: user,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseJsonSchema: episodeJsonSchema,
        },
      });
      break;
    } catch (err) {
      const retryable = err instanceof GeminiApiError && (err.status === 429 || err.status >= 500);
      if (!retryable || attempt >= 4) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
  return parseDraft(response.text, response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "unknown");
}

// DeepSeek speaks the OpenAI chat API. Its JSON mode doesn't take a schema, so the schema
// goes in the prompt and the reply is checked against it here.
async function draftWithDeepSeek(model, system, user, apiKey) {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: `${system}\n\nReply with only a JSON object matching this JSON schema:\n${JSON.stringify(episodeJsonSchema)}` },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    max_tokens: 16000,
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body,
    });
    if (res.status === 401) throw new Error("The DeepSeek API key was rejected. Check DEEPSEEK_API_KEY.");
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * 2 ** attempt); continue; }
    if (!res.ok) throw new Error(`DeepSeek API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const choice = data.choices?.[0];
    return parseDraft(choice?.message?.content, choice?.finish_reason ?? "unknown");
  }
}
