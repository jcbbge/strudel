/**
 * MCP-config forager.
 *
 * Matches files that are well-known MCP server-config carriers:
 *   - `.mcp.json`, `mcp.json`           — repo-local
 *   - `claude_desktop_config.json`      — Claude Desktop user config
 *   - `mcp.config.json`                 — Cursor / others
 *
 * Plus any *.json file whose top-level object has an `mcpServers` key
 * (cheap content-sniff so config files with non-standard names still land).
 *
 * One candidate per file. The cupboard-curator decides whether each entry
 * inside the file becomes a separate `kind: "mcp"` ingredient.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Forager, ForagerContext, RawCandidate } from "../forager.js";
import { fileToCandidate, walkFiles } from "./walk.js";

const NAMED_MCP_FILES = new Set(["mcp.json", ".mcp.json", "claude_desktop_config.json", "mcp.config.json"]);

const MCP_SERVERS_KEY = /"mcpServers"\s*:/;

export class McpConfigForager implements Forager {
	readonly paradigm = "mcp-config";
	readonly description =
		"Walks for MCP server configurations: well-known filenames plus any JSON containing an mcpServers key.";

	async *forage(ctx: ForagerContext): AsyncIterable<RawCandidate> {
		const log = ctx.log ?? (() => {});
		for await (const file of walkFiles(ctx.root, {
			accept: (_full, name) => name.endsWith(".json"),
		})) {
			const base = path.basename(file).toLowerCase();
			let matchedBy: "filename" | "content" | undefined;
			if (NAMED_MCP_FILES.has(base)) {
				matchedBy = "filename";
			} else {
				try {
					const head = await readHead(file, 16 * 1024);
					if (MCP_SERVERS_KEY.test(head)) matchedBy = "content";
				} catch {
					continue;
				}
			}
			if (!matchedBy) continue;

			const candidate = await fileToCandidate(file, {
				paradigm: this.paradigm,
				hashPrefix: `mcp-config:${file}`,
				adapterMeta: { matched_by: matchedBy, filename: path.basename(file) },
			});
			if (candidate) {
				log(`mcp-config: candidate ${file} (${matchedBy})`);
				yield candidate;
			}
		}
	}
}

async function readHead(file: string, bytes: number): Promise<string> {
	const handle = await fs.open(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buf, 0, bytes, 0);
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}
