/**
 * Research-only guard for a subagent's file tools.
 *
 * Subagents investigate; they should not change the project. pi's `write` and
 * `edit` tools are limited to the subagent's own directory and the temp
 * directory. This is a safety net against a model "helpfully" editing files,
 * not a sandbox: shell commands and MCP tools are not restricted.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Identity } from "./types.ts";

const GUARDED_TOOLS = new Set(["write", "edit"]);

function inside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Directories a subagent may write to with the file tools. */
export function writableRoots(identity: Identity): string[] {
	const temp = tmpdir();
	return [...new Set([identity.dir, real(identity.dir), temp, real(temp), "/tmp", "/private/tmp"])];
}

/** Returns the reason a tool call is refused, or undefined when it may proceed. */
export function refusal(toolName: string, input: unknown, cwd: string, identity: Identity): string | undefined {
	if (!GUARDED_TOOLS.has(toolName)) return undefined;
	const raw = (input as { path?: unknown } | undefined)?.path;
	if (typeof raw !== "string" || !raw) return undefined; // Let the tool report its own argument error.
	const target = resolve(cwd, raw);
	if (writableRoots(identity).some((root) => inside(target, root))) return undefined;
	return (
		`Subagents are research-only: ${toolName} is limited to ${join(identity.dir, "artifacts")} and the temp directory. ` +
		"Do not change project files; describe the change in your report instead."
	);
}
