#!/usr/bin/env node
// Catalog evaluation with optional live embeddings and TypeSafe reranking.
// No Pi execution, product config changes, or shared cache writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [mode, output] = process.argv.slice(2);
if (!["baseline", "jev"].includes(mode) || !output) {
	throw new Error(
		"Usage: node scripts/evaluate-retrieval.mjs baseline|jev <private-output-dir>",
	);
}
process.umask(0o077);
const dir = path.resolve(output);
const digest = (value) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const save = async (file, value) =>
	fs.writeFile(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`, {
		flag: "wx",
	});
const key = (p) => `${p.kind}/${p.name}`;
const coverage = (required, selected) =>
	required.length
		? required.filter((group) => group.some((id) => selected.includes(id)))
				.length / required.length
		: null;

await fs.mkdir(dir, { recursive: true, mode: 0o700 });
if (mode === "baseline") {
	const cases = await read(path.join(repo, "test/retrieval-cases.json"));
	// Write labels before scoring; refusing overwrite prevents accidental retuning in place.
	await save("cases.json", cases);
	const config = await read(
		process.env.STRUDEL_CONFIG_PATH ||
			path.join(homedir(), ".strudel/config.json"),
	);
	const jiti = createJiti(import.meta.url);
	const { indexRoots, isOnDemand, lexicalSearch } = await jiti.import(
		process.env.STRUDEL_PANTRY_MODULE || path.join(repo, "src/pantry.ts"),
	);
	const { semanticSearch, httpEmbedder } = await jiti.import(
		path.join(repo, "src/embeddings.ts"),
	);
	const all = await indexRoots(
		config.pantry?.roots || ["~/.pi/agent", "~/.strudel"],
	);
	const items = all.filter(isOnDemand);
	await save("catalog.json", all);
	const initialCache = process.env.STRUDEL_EVAL_CACHE;
	if (initialCache)
		await fs.copyFile(initialCache, path.join(dir, "embeddings.json"));
	const metrics = [];
	const frozen = [];
	const embed = config.embeddings ? httpEmbedder(config.embeddings) : undefined;
	for (const task of cases) {
		const spans = [];
		const start = performance.now();
		const lexical = lexicalSearch(items, task.query, 20);
		const candidates = embed
			? await semanticSearch(
					items,
					task.query,
					async (texts) => {
						const t = performance.now();
						const result = await embed(texts);
						spans.push({
							phase:
								texts.length === 1 && texts[0] === task.query
									? "query"
									: "catalog",
							count: texts.length,
							ms: performance.now() - t,
						});
						return result;
					},
					path.join(dir, "embeddings.json"),
					20,
				)
			: lexical;
		const ids = candidates.map(key);
		const selected = ids.slice(0, 5);
		frozen.push({
			id: task.id,
			query: task.query,
			required: task.required,
			candidates,
			candidateHash: digest(candidates),
		});
		metrics.push({
			id: task.id,
			ms: performance.now() - start,
			spans,
			lexicalCoverage5: coverage(task.required, lexical.slice(0, 5).map(key)),
			candidateCoverage20: coverage(task.required, ids),
			selectedCoverage5: coverage(task.required, selected),
			selected,
			negativeCase: task.required.length === 0,
			irrelevantSelections: selected.filter(
				(id) => !task.required.some((group) => group.includes(id)),
			).length,
		});
	}
	await save("frozen.json", {
		casesHash: digest(cases),
		catalogHash: digest(all),
		mode: embed ? "semantic" : "lexical",
		candidateCount: 20,
		selectedCount: 5,
		tasks: frozen,
	});
	await save("baseline.json", metrics);
	console.log(
		JSON.stringify({
			output: dir,
			indexed: all.length,
			searchable: items.length,
			tasks: metrics.length,
			completeCoverage5: metrics.filter((m) => m.selectedCoverage5 === 1)
				.length,
			positiveTasks: metrics.filter((m) => !m.negativeCase).length,
		}),
	);
} else {
	const apiKey = process.env.TYPESAFE_API_KEY;
	if (!apiKey)
		throw new Error(
			"BLOCKED: TYPESAFE_API_KEY is not configured; frozen baseline is preserved.",
		);
	const frozen = await read(path.join(dir, "frozen.json"));
	const results = [];
	for (const task of frozen.tasks) {
		assert.equal(
			digest(task.candidates),
			task.candidateHash,
			"Candidate snapshot changed",
		);
		const questions = Object.fromEntries(
			task.candidates.map((_, i) => [
				`c${i}`,
				{
					type: "score",
					instructions: `How useful is state.candidates[${i}] for accomplishing state.task? Judge this candidate independently; several capabilities may be useful.`,
					criteria: [
						"Unrelated or unusable for this task",
						"Related topic but no concrete help for this task",
						"Useful for a part of the requested work",
						"Directly enables a required part of the requested work",
					],
				},
			]),
		);
		const request = {
			model: process.env.TYPESAFE_MODEL || "jev-latest",
			state: {
				task: task.query,
				candidates: task.candidates.map((p) => ({
					id: key(p),
					description: p.description,
				})),
			},
			questions,
		};
		await save(`jev-request-${task.id}.json`, request);
		const start = performance.now();
		const response = await fetch("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(60000),
		});
		const body = await response.json();
		await save(`jev-response-${task.id}.json`, {
			status: response.status,
			elapsedMs: performance.now() - start,
			body,
		});
		if (!response.ok)
			throw new Error(
				`TypeSafe HTTP ${response.status}; response saved, evaluation stopped`,
			);
		const ranked = task.candidates
			.map((candidate, i) => {
				const answer = body.answers?.[`c${i}`];
				assert(
					answer?.type === "score" &&
						Number.isFinite(answer.score) &&
						answer.score >= 0 &&
						answer.score <= 3,
					"Invalid TypeSafe score",
				);
				return {
					id: key(candidate),
					score: answer.score,
					confidence: answer.confidence,
				};
			})
			.sort((a, b) => b.score - a.score);
		const selected = ranked.slice(0, frozen.selectedCount).map((p) => p.id);
		results.push({
			id: task.id,
			candidateHash: task.candidateHash,
			selected,
			selectedCoverage5: coverage(task.required, selected),
			ranked,
			usage: body.usage,
		});
	}
	await save("jev.json", results);
	console.log(JSON.stringify({ output: dir, evaluated: results.length }));
}
