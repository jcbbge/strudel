/**
 * Introspection command tests.
 *
 * These test that the commands execute without error and produce expected output.
 * They mock the Pi extension API since we can't run inside a real Pi instance.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexRoots } from "../src/pantry.js";
import {
	STRUDEL_VERSION,
	type StrudelConfig,
	initState,
} from "../src/state.js";

// Mock ExtensionAPI
function createMockPi() {
	const messages: Array<{ customType: string; content: string }> = [];
	const commands: Array<{
		name: string;
		description: string;
		handler: Function;
	}> = [];

	return {
		registerCommand(
			name: string,
			opts: { description: string; handler: Function },
		) {
			commands.push({
				name,
				description: opts.description,
				handler: opts.handler,
			});
		},
		sendMessage(msg: { customType: string; content: string }) {
			messages.push(msg);
		},
		getAllTools: () => [
			{ name: "read", description: "Read files" },
			{ name: "write", description: "Write files" },
			{ name: "edit", description: "Edit files" },
			{ name: "bash", description: "Run bash" },
			{ name: "strudel_search", description: "Search pantry" },
			{ name: "suppressed_tool", description: "Should be suppressed" },
		],
		getCommands: () =>
			commands.map((c) => ({ name: c.name, description: c.description })),
		// Test helpers
		_messages: messages,
		_commands: commands,
		_findCommand: (name: string) => commands.find((c) => c.name === name),
	};
}

// Mock context
function createMockCtx(mode: "tui" | "print" = "print") {
	return {
		mode,
		ui: {
			notify: vi.fn(),
		},
	};
}

let testRoot: string;
let mockPi: ReturnType<typeof createMockPi>;

beforeEach(async () => {
	testRoot = join(tmpdir(), `strudel-cmd-test-${Date.now()}`);
	mkdirSync(join(testRoot, "skills"), { recursive: true });
	mkdirSync(join(testRoot, "rules"), { recursive: true });

	// Create test primitives
	writeFileSync(
		join(testRoot, "skills", "test-skill.md"),
		"---\nname: test-skill\ndescription: A test skill\n---\nContent",
	);
	writeFileSync(
		join(testRoot, "rules", "test-rule.md"),
		"---\nname: test-rule\ndescription: A test rule\n---\nContent",
	);

	mockPi = createMockPi();

	// Initialize state
	const config: StrudelConfig = {
		roots: [testRoot],
		surface: "pragmatic",
	};
	const fileIndex = await indexRoots([testRoot]);

	initState({
		config,
		fileIndex,
		activated: new Set<string>(),
		baseline: ["read", "write", "edit", "bash", "strudel_search"],
		pi: mockPi as any,
	});
});

afterEach(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

describe("status command", async () => {
	const { registerStatusCommand } = await import("../src/commands/status.js");

	it("registers /strudel command", () => {
		registerStatusCommand(mockPi as any);
		expect(mockPi._findCommand("strudel")).toBeDefined();
	});

	it("outputs status with correct version", async () => {
		registerStatusCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain(`Strudel v${STRUDEL_VERSION}`);
		expect(output.join("\n")).toContain("Pantry:");
		expect(output.join("\n")).toContain("Surface:");
	});

	it("shows primitives count", async () => {
		registerStatusCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain("2 primitives indexed");
	});
});

describe("health command", async () => {
	const { registerHealthCommand } = await import("../src/commands/health.js");

	it("registers /strudel-health command", () => {
		registerHealthCommand(mockPi as any);
		expect(mockPi._findCommand("strudel-health")).toBeDefined();
	});

	it("outputs health check", async () => {
		registerHealthCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-health");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain("Health Check");
		expect(output.join("\n")).toContain("Pantry roots:");
		expect(output.join("\n")).toContain("Overall:");
	});

	it("shows root exists", async () => {
		registerHealthCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-health");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("", createMockCtx());

		console.log = originalLog;
		// testRoot should exist and have 2 primitives
		expect(output.join("\n")).toContain("readable, 2 primitives");
	});
});

describe("pantry command", async () => {
	const { registerPantryCommand } = await import("../src/commands/pantry.js");

	it("registers /strudel-pantry command", () => {
		registerPantryCommand(mockPi as any);
		expect(mockPi._findCommand("strudel-pantry")).toBeDefined();
	});

	it("lists primitives by kind", async () => {
		registerPantryCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-pantry");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain("skill/");
		expect(output.join("\n")).toContain("rule/");
		expect(output.join("\n")).toContain("test-skill");
		expect(output.join("\n")).toContain("test-rule");
	});

	it("filters by kind", async () => {
		registerPantryCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-pantry");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("--kind skill", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain("skill/");
		expect(output.join("\n")).toContain("test-skill");
		expect(output.join("\n")).not.toContain("rule/");
	});

	it("marks ambient kinds", async () => {
		registerPantryCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-pantry");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain("[ambient — not searchable]");
	});
});

describe("surface command", async () => {
	const { registerSurfaceCommand } = await import("../src/commands/surface.js");

	it("registers /strudel-surface command", () => {
		registerSurfaceCommand(mockPi as any);
		expect(mockPi._findCommand("strudel-surface")).toBeDefined();
	});

	it("shows baseline tools", async () => {
		registerSurfaceCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-surface");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain("Baseline tools");
		expect(output.join("\n")).toContain("read");
		expect(output.join("\n")).toContain("write");
	});

	it("shows suppressed count", async () => {
		registerSurfaceCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-surface");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain("suppressed");
	});
});

describe("search command", async () => {
	const { registerSearchCommand } = await import("../src/commands/search.js");

	it("registers /strudel-search command", () => {
		registerSearchCommand(mockPi as any);
		expect(mockPi._findCommand("strudel-search")).toBeDefined();
	});

	it("requires a query", async () => {
		registerSearchCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-search");
		const ctx = createMockCtx();

		await cmd!.handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Usage"),
			"error",
		);
	});

	it("searches and shows results", async () => {
		registerSearchCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-search");
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);

		await cmd!.handler("test", createMockCtx());

		console.log = originalLog;
		expect(output.join("\n")).toContain('Search: "test"');
		expect(output.join("\n")).toContain("Score");
		expect(output.join("\n")).toContain("Search time:");
	});
});
