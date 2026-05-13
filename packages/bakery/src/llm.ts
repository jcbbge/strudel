/**
 * Local LLM helper. Talks to an OpenAI-compatible endpoint
 * (default: MLX server on http://127.0.0.1:8080/v1).
 *
 * All calls are best-effort. If the server is not reachable, the helper
 * returns undefined and the Pantry falls back to lexical-only behavior.
 */

import type { IngredientKind } from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_CHAT_MODEL = "mlx-community/Qwen3-8B-4bit";
const DEFAULT_EMBEDDING_MODEL = "mlx-community/Qwen3-Embedding-4B-4bit-DWQ";
const PROBE_TIMEOUT_MS = 800;
const CALL_TIMEOUT_MS = 30_000;

export interface LocalLlmOptions {
	baseUrl?: string;
	chatModel?: string;
	embeddingModel?: string;
	apiKey?: string;
}

export class LocalLlm {
	private readonly baseUrl: string;
	private readonly chatModel: string;
	private readonly embeddingModel: string;
	private readonly apiKey: string;
	private availability: "unknown" | "available" | "unavailable" = "unknown";

	constructor(options: LocalLlmOptions = {}) {
		this.baseUrl = (options.baseUrl ?? process.env.STRUDEL_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
		this.chatModel = options.chatModel ?? process.env.STRUDEL_LLM_CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
		this.embeddingModel =
			options.embeddingModel ?? process.env.STRUDEL_LLM_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
		this.apiKey = options.apiKey ?? process.env.STRUDEL_LLM_API_KEY ?? "not-needed";
	}

	get info(): { baseUrl: string; chatModel: string; embeddingModel: string } {
		return { baseUrl: this.baseUrl, chatModel: this.chatModel, embeddingModel: this.embeddingModel };
	}

	/** Cheap probe of /v1/models. Caches the result for subsequent calls. */
	async isAvailable(): Promise<boolean> {
		if (this.availability !== "unknown") return this.availability === "available";
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
			const response = await fetch(`${this.baseUrl}/models`, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
				signal: controller.signal,
			});
			clearTimeout(timer);
			this.availability = response.ok ? "available" : "unavailable";
		} catch {
			this.availability = "unavailable";
		}
		return this.availability === "available";
	}

	/** Generate an embedding for a piece of text. Returns undefined if the LLM is down. */
	async embed(text: string): Promise<number[] | undefined> {
		if (!(await this.isAvailable())) return undefined;
		try {
			const response = await this.callJson(`${this.baseUrl}/embeddings`, {
				model: this.embeddingModel,
				input: text,
			});
			const data = (response as { data?: Array<{ embedding?: number[] }> }).data;
			const embedding = data?.[0]?.embedding;
			return Array.isArray(embedding) ? embedding : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Auto-categorize an ingredient given its name + flavor + description.
	 * Returns up to ~6 short tag strings, lower-case, snake_case-ish.
	 */
	async tag(input: { name: string; flavor: string; description?: string }): Promise<string[] | undefined> {
		if (!(await this.isAvailable())) return undefined;
		const prompt = `You are tagging an ingredient in a coding-agent bakery.
Return a JSON array of 3-6 short snake_case tags that describe the ingredient's purpose, domain, and surface area. Lower case only, no spaces.

Name: ${input.name}
Flavor: ${input.flavor}
${input.description ? `Description: ${input.description}\n` : ""}
Output format: a JSON array of strings, nothing else. The tags MUST describe THIS ingredient, not the format example.`;
		try {
			const response = await this.callJson(`${this.baseUrl}/chat/completions`, {
				model: this.chatModel,
				messages: [{ role: "user", content: prompt }],
				// Reasoning models (e.g. Qwen3) emit a <think>…</think> block first;
				// give them headroom for the chain-of-thought + the JSON answer.
				max_tokens: 1024,
				temperature: 0,
			});
			const raw =
				(response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
			// Strip reasoning-model think blocks before extracting the JSON array.
			const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
			const match = text.match(/\[[\s\S]*?\]/);
			if (!match) return undefined;
			const parsed = JSON.parse(match[0]) as unknown;
			if (!Array.isArray(parsed)) return undefined;
			return parsed
				.filter((t): t is string => typeof t === "string")
				.map((t) => t.trim().toLowerCase())
				.filter((t) => t.length > 0)
				.slice(0, 6);
		} catch {
			return undefined;
		}
	}

	/**
	 * Classify a foraged candidate. Returns one of the nine ingredient kinds
	 * plus a proposed name, flavor, tags, dependencies, and confidence.
	 *
	 * Returns undefined on any failure (LLM down, malformed JSON, refusal).
	 * The Curator falls back to a heuristic in that case.
	 */
	async classify(input: {
		paradigm: string;
		source_path: string;
		content_size: number;
		adapter_meta?: Record<string, unknown>;
		content: string;
	}): Promise<
		| {
				kind: IngredientKind;
				name: string;
				flavor: string;
				description?: string;
				tags?: string[];
				dependencies?: string[];
				confidence: "low" | "medium" | "high";
				reasoning?: string;
		  }
		| undefined
	> {
		if (!(await this.isAvailable())) return undefined;
		const meta = input.adapter_meta ? JSON.stringify(input.adapter_meta) : "(none)";
		const prompt = `You are the cupboard-curator in a coding-agent bakery. Classify ONE foraged candidate.

The Pantry knows nine ingredient kinds:
  - directive: prompt prefix / persona / always-on instruction
  - command:   slash command or scripted shortcut
  - skill:     bundled how-to with optional resources (Claude Skills, etc.)
  - hook:      script run on a lifecycle event
  - tool:      callable function exposed to the agent
  - mcp:       Model Context Protocol server config / entry
  - plugin:    extension package that registers tools/commands/hooks
  - agent:     a top-level agent definition
  - subagent:  a delegated agent with a focused role

Candidate metadata:
  paradigm:     ${input.paradigm}
  source_path:  ${input.source_path}
  content_size: ${input.content_size} bytes
  adapter_meta: ${meta}

Content (truncated):
"""
${input.content}
"""

Decide:
  1. The most appropriate "kind" (one of the nine above).
  2. A short snake_case "name" — usually "<kind>.<slug>".
  3. A one-line "flavor" (<= 140 chars) describing what it does.
  4. An optional longer "description".
  5. 3–6 short snake_case "tags" describing purpose / domain.
  6. Optional "dependencies" (other ingredient names this needs).
  7. Confidence: "low" / "medium" / "high".
  8. A one-line "reasoning" note.

Return ONE JSON object matching this shape, nothing else:
{ "kind": "...", "name": "...", "flavor": "...", "description": "...",
  "tags": ["..."], "dependencies": [], "confidence": "...", "reasoning": "..." }`;

		try {
			const response = await this.callJson(`${this.baseUrl}/chat/completions`, {
				model: this.chatModel,
				messages: [{ role: "user", content: prompt }],
				max_tokens: 2048,
				temperature: 0,
			});
			const raw =
				(response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
			const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
			const match = text.match(/\{[\s\S]*\}/);
			if (!match) return undefined;
			const parsed = JSON.parse(match[0]) as Record<string, unknown>;
			const kind = typeof parsed.kind === "string" ? parsed.kind : undefined;
			const name = typeof parsed.name === "string" ? parsed.name.trim() : undefined;
			const flavor = typeof parsed.flavor === "string" ? parsed.flavor.trim() : undefined;
			if (!kind || !name || !flavor) return undefined;
			const allowed = new Set([
				"directive",
				"command",
				"skill",
				"hook",
				"tool",
				"mcp",
				"plugin",
				"agent",
				"subagent",
			]);
			if (!allowed.has(kind)) return undefined;
			const confidence = (
				parsed.confidence === "low" || parsed.confidence === "medium" || parsed.confidence === "high"
					? parsed.confidence
					: "low"
			) as "low" | "medium" | "high";
			return {
				kind: kind as IngredientKind,
				name,
				flavor,
				description: typeof parsed.description === "string" ? parsed.description : undefined,
				tags: Array.isArray(parsed.tags)
					? parsed.tags.filter((t): t is string => typeof t === "string")
					: undefined,
				dependencies: Array.isArray(parsed.dependencies)
					? parsed.dependencies.filter((d): d is string => typeof d === "string")
					: undefined,
				confidence,
				reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
			};
		} catch {
			return undefined;
		}
	}

	private async callJson(url: string, body: unknown): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`LLM HTTP ${response.status} ${response.statusText}`);
			}
			return await response.json();
		} finally {
			clearTimeout(timer);
		}
	}
}
