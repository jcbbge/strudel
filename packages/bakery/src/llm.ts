/**
 * Local LLM helper. Talks to an OpenAI-compatible endpoint
 * (default: MLX server on http://127.0.0.1:8080/v1).
 *
 * All calls are best-effort. If the server is not reachable, the helper
 * returns undefined and the Pantry falls back to lexical-only behavior.
 */

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
Respond with ONLY the JSON array, e.g. ["http","scraping","retry"].`;
		try {
			const response = await this.callJson(`${this.baseUrl}/chat/completions`, {
				model: this.chatModel,
				messages: [{ role: "user", content: prompt }],
				max_tokens: 128,
				temperature: 0,
			});
			const text =
				(response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
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
