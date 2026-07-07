/**
 * The Oven — recipe execution engine.
 *
 * Loads tools from ~/.strudel/tools/, executes recipe layers sequentially,
 * resolves $N.field bindings between steps.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { createJiti } from "jiti";

let TOOLS_DIR = join(homedir(), ".strudel", "tools");

/** For testing: override the tools directory */
export function setToolsDir(dir: string): void {
	TOOLS_DIR = dir;
	toolCache.clear();
}

/** For testing: reset to default */
export function resetToolsDir(): void {
	TOOLS_DIR = join(homedir(), ".strudel", "tools");
	toolCache.clear();
}

/** Persist workspace state after bake completes */
async function persistWorkspaceState(): Promise<void> {
	try {
		const wsPath = join(TOOLS_DIR, "_lib", "workspace.ts");
		if (!existsSync(wsPath)) return;
		const ws = (await jiti.import(wsPath)) as { persistWorkspace?: () => void };
		if (typeof ws.persistWorkspace === "function") {
			ws.persistWorkspace();
		}
	} catch {
		// Silent fail — persistence is best-effort
	}
}

/**
 * Expand ~ to home directory in strings
 */
export function expandTilde(value: unknown): unknown {
	if (typeof value === "string" && value.startsWith("~")) {
		return join(homedir(), value.slice(1));
	}
	if (Array.isArray(value)) {
		return value.map(expandTilde);
	}
	if (typeof value === "object" && value !== null) {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			result[k] = expandTilde(v);
		}
		return result;
	}
	return value;
}

export interface RecipeLayer {
	step: number;
	ingredient: string; // tool name, e.g. "tool.read" or just "read"
	inputs: Record<string, unknown>;
}

export interface Recipe {
	goal: string;
	layers: RecipeLayer[];
}

export interface StepResult {
	step: number;
	ingredient: string;
	inputs: Record<string, unknown>;
	output: unknown;
	durationMs: number;
	error?: string;
}

export interface BakeResult {
	goal: string;
	success: boolean;
	steps: StepResult[];
	finalOutput: unknown;
	totalDurationMs: number;
	error?: string;
}

// Tool cache — loaded once per session
const toolCache = new Map<
	string,
	(inputs: Record<string, unknown>) => Promise<unknown>
>();

/**
 * Normalize tool name: "tool.read" -> "read", "read" -> "read"
 */
export function normalizeName(name: string): string {
	return name.startsWith("tool.") ? name.slice(5) : name;
}

// Create jiti instance for loading TypeScript tools
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
});

/**
 * Load a tool from ~/.strudel/tools/
 */
async function loadTool(
	name: string,
): Promise<(inputs: Record<string, unknown>) => Promise<unknown>> {
	const normalized = normalizeName(name);

	const cached = toolCache.get(normalized);
	if (cached) {
		return cached;
	}

	const toolPath = join(TOOLS_DIR, `${normalized}.ts`);
	if (!existsSync(toolPath)) {
		throw new Error(`Tool not found: ${name} (looked for ${toolPath})`);
	}

	// Use jiti to load TypeScript files
	const module = await jiti.import(toolPath);
	const fn = (module as { default?: unknown }).default ?? module;

	if (typeof fn !== "function") {
		throw new Error(`Tool ${name} does not export a default function`);
	}

	toolCache.set(
		normalized,
		fn as (inputs: Record<string, unknown>) => Promise<unknown>,
	);
	return fn as (inputs: Record<string, unknown>) => Promise<unknown>;
}

/**
 * List available tools
 */
export function listTools(): string[] {
	if (!existsSync(TOOLS_DIR)) return [];

	return readdirSync(TOOLS_DIR)
		.filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
		.map((f) => basename(f, extname(f)));
}

/**
 * Resolve $N.field bindings in an object against previous step results.
 *
 * Examples:
 *   "$1.path" -> stepResults[0].output.path
 *   "$2.content" -> stepResults[1].output.content
 *   "$1" -> stepResults[0].output (entire output)
 */
function resolveBindings(
	obj: Record<string, unknown>,
	stepResults: StepResult[],
): Record<string, unknown> {
	const resolved: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string" && value.startsWith("$")) {
			resolved[key] = resolveBinding(value, stepResults);
		} else if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			resolved[key] = resolveBindings(
				value as Record<string, unknown>,
				stepResults,
			);
		} else {
			resolved[key] = value;
		}
	}

	return resolved;
}

function resolveBinding(binding: string, stepResults: StepResult[]): unknown {
	const match = binding.match(/^\$(\d+)(?:\.(.+))?$/);
	if (!match) return binding; // Not a binding, return as-is

	const stepNum = Number.parseInt(match[1], 10);
	const fieldPath = match[2];

	if (stepNum < 1 || stepNum > stepResults.length) {
		throw new Error(
			`Invalid binding ${binding}: step ${stepNum} doesn't exist (only ${stepResults.length} steps completed)`,
		);
	}

	const stepOutput = stepResults[stepNum - 1].output;

	if (!fieldPath) return stepOutput;

	// Navigate the field path
	let current: unknown = stepOutput;
	for (const part of fieldPath.split(".")) {
		if (current === null || current === undefined) {
			throw new Error(
				`Binding ${binding}: cannot access '${part}' on ${current}`,
			);
		}
		if (typeof current !== "object") {
			throw new Error(
				`Binding ${binding}: cannot access '${part}' on non-object`,
			);
		}
		current = (current as Record<string, unknown>)[part];
	}

	return current;
}

/**
 * Execute a recipe — the core bake operation.
 */
export async function bake(recipe: Recipe): Promise<BakeResult> {
	const startTime = Date.now();
	const stepResults: StepResult[] = [];
	let finalOutput: unknown = null;
	let error: string | undefined;

	for (const layer of recipe.layers.sort((a, b) => a.step - b.step)) {
		const stepStart = Date.now();

		try {
			// Load the tool
			const tool = await loadTool(layer.ingredient);

			// Resolve any bindings in the inputs, then expand tildes
			const resolvedInputs = expandTilde(
				resolveBindings(layer.inputs, stepResults),
			) as Record<string, unknown>;

			// Execute
			const output = await tool(resolvedInputs);

			stepResults.push({
				step: layer.step,
				ingredient: layer.ingredient,
				inputs: resolvedInputs,
				output,
				durationMs: Date.now() - stepStart,
			});

			finalOutput = output;
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			stepResults.push({
				step: layer.step,
				ingredient: layer.ingredient,
				inputs: layer.inputs,
				output: null,
				durationMs: Date.now() - stepStart,
				error: errMsg,
			});
			error = `Step ${layer.step} (${layer.ingredient}) failed: ${errMsg}`;
			break; // Stop on first error
		}
	}

	// Persist workspace state after bake completes
	await persistWorkspaceState();

	return {
		goal: recipe.goal,
		success: !error,
		steps: stepResults,
		finalOutput,
		totalDurationMs: Date.now() - startTime,
		error,
	};
}

/**
 * Validate a recipe without executing it.
 */
export async function prep(recipe: Recipe): Promise<{
	valid: boolean;
	tools: Array<{ name: string; found: boolean }>;
	bindings: Array<{
		step: number;
		binding: string;
		valid: boolean;
		reason?: string;
	}>;
	errors: string[];
}> {
	const errors: string[] = [];
	const tools: Array<{ name: string; found: boolean }> = [];
	const bindings: Array<{
		step: number;
		binding: string;
		valid: boolean;
		reason?: string;
	}> = [];

	const availableTools = new Set(listTools());

	// Check each layer
	for (const layer of recipe.layers) {
		const normalized = normalizeName(layer.ingredient);
		const found = availableTools.has(normalized);
		tools.push({ name: layer.ingredient, found });

		if (!found) {
			errors.push(`Step ${layer.step}: tool '${layer.ingredient}' not found`);
		}

		// Check bindings
		for (const [key, value] of Object.entries(layer.inputs)) {
			if (typeof value === "string" && value.startsWith("$")) {
				const match = value.match(/^\$(\d+)/);
				if (match) {
					const refStep = Number.parseInt(match[1], 10);
					if (refStep >= layer.step) {
						bindings.push({
							step: layer.step,
							binding: value,
							valid: false,
							reason: `References step ${refStep} which hasn't executed yet`,
						});
						errors.push(
							`Step ${layer.step}: binding '${value}' references future step ${refStep}`,
						);
					} else if (refStep < 1) {
						bindings.push({
							step: layer.step,
							binding: value,
							valid: false,
							reason: `Invalid step number ${refStep}`,
						});
						errors.push(`Step ${layer.step}: invalid binding '${value}'`);
					} else {
						bindings.push({ step: layer.step, binding: value, valid: true });
					}
				}
			}
		}
	}

	// Check for duplicate step numbers
	const stepNums = recipe.layers.map((l) => l.step);
	const duplicates = stepNums.filter((n, i) => stepNums.indexOf(n) !== i);
	if (duplicates.length > 0) {
		errors.push(
			`Duplicate step numbers: ${[...new Set(duplicates)].join(", ")}`,
		);
	}

	return {
		valid: errors.length === 0,
		tools,
		bindings,
		errors,
	};
}
