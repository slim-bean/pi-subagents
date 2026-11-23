/**
 * Interactive editor behind `/subagents settings`: a menu of settings; picking
 * one changes it and saves at once. Uses only select/input dialogs, so it works
 * in the TUI and over RPC. No pi imports: the UI is passed in.
 */
import { join } from "node:path";
import { CONFIG_FILE, loadSettings, readSettingsFile, THINKING_LEVELS, updateSettingsFile } from "./config.ts";
import type { Settings } from "./types.ts";

export interface EditorUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface EditorOptions {
	/** pi's agent directory; its subagents.json applies to every project. */
	agentDir: string;
	/** The project's `.pi` directory when the project is trusted. */
	projectDir?: string;
	/** "provider/id" of models offered in the model picker. */
	models: string[];
}

type Row =
	| { kind: "model"; label: string; path: string[] }
	| { kind: "choice"; label: string; path: string[]; choices: readonly string[] }
	| { kind: "number"; label: string; path: string[]; min: number; integer?: boolean; unit: string; zero?: string }
	| { kind: "toggle"; label: string; path: string[]; on: string; off: string }
	| { kind: "list"; label: string; path: string[] };

const ROWS: Row[] = [
	{ kind: "model", label: "Default model", path: ["model"] },
	{ kind: "choice", label: "Thinking level", path: ["thinking"], choices: THINKING_LEVELS },
	{ kind: "number", label: "Turn limit per assignment", path: ["limits", "maxTurns"], min: 0, integer: true, unit: "turns", zero: "no limit" },
	{ kind: "number", label: "Time limit per assignment", path: ["limits", "maxMinutes"], min: 0, unit: "minutes", zero: "no limit" },
	{ kind: "number", label: "Cost limit per assignment", path: ["limits", "maxCostUsd"], min: 0, unit: "USD", zero: "no limit" },
	{ kind: "number", label: "Subagents running at once", path: ["maxConcurrent"], min: 1, integer: true, unit: "" },
	{ kind: "number", label: "Keep an idle process for", path: ["idleMinutes"], min: 0, unit: "minutes" },
	{ kind: "number", label: "Report size cap", path: ["reportMaxChars"], min: 1000, integer: true, unit: "characters" },
	{ kind: "choice", label: "Background completions reach the agent", path: ["notify"], choices: ["interrupt", "next", "off"] },
	{ kind: "toggle", label: "Subagent file tools", path: ["readOnly"], on: "research-only (own directory and temp)", off: "unrestricted" },
	{ kind: "list", label: "Hand API keys to subagents for", path: ["forwardAuth"] },
];

const UNSET = "Unset (use the default)";
const CUSTOM = "Enter a provider/model ID…";

function valueAt(source: unknown, path: string[]): unknown {
	let value = source;
	for (const key of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
	return value;
}

function show(row: Row, settings: Settings): string {
	const value = valueAt(settings, row.path);
	switch (row.kind) {
		case "model":
			return (value as string | undefined) ?? "the requesting session's model";
		case "choice":
			return (value as string | undefined) ?? "default";
		case "number":
			return value === 0 && row.zero ? row.zero : `${value}${row.unit ? ` ${row.unit}` : ""}`;
		case "toggle":
			return value ? row.on : row.off;
		case "list":
			return (value as string[]).join(", ") || "none";
	}
}

/** Returns the top-level keys that were changed. */
export async function editSettings(ui: EditorUi, options: EditorOptions): Promise<Set<string>> {
	const changed = new Set<string>();
	const globalFile = join(options.agentDir, CONFIG_FILE);
	const projectFile = options.projectDir ? join(options.projectDir, CONFIG_FILE) : undefined;
	let scope: "global" | "project" = "global";

	while (true) {
		const file = scope === "project" && projectFile ? projectFile : globalFile;
		// Global scope shows the global file alone; project scope shows what this project gets.
		const settings = loadSettings(options.agentDir, scope === "project" ? options.projectDir : undefined).settings;
		const projectRead = projectFile ? readSettingsFile(projectFile) : undefined;
		const projectRaw = projectRead && "raw" in projectRead ? projectRead.raw : {};
		const labels = ROWS.map((row) => {
			const shadowed = scope === "global" && valueAt(projectRaw, row.path) !== undefined;
			return `${row.label}: ${show(row, settings)}${shadowed ? "  (this project overrides it)" : ""}`;
		});
		const scopeLabel = projectFile
			? `Saving to: ${scope === "global" ? "all projects" : "this project only"} (${file}). Select to switch`
			: undefined;
		const done = "Done";
		const picked = await ui.select(`Subagent settings. Changes save immediately to ${file}`, [
			...labels,
			...(scopeLabel ? [scopeLabel] : []),
			done,
		]);
		if (picked === undefined || picked === done) return changed;
		if (picked === scopeLabel) {
			scope = scope === "global" ? "project" : "global";
			continue;
		}
		const row = ROWS[labels.indexOf(picked)];
		if (!row) continue;

		let value: unknown;
		if (row.kind === "toggle") {
			value = !valueAt(settings, row.path);
		} else if (row.kind === "choice") {
			const choice = await ui.select(row.label, [UNSET, ...row.choices]);
			if (choice === undefined) continue;
			value = choice === UNSET ? undefined : choice;
		} else if (row.kind === "model") {
			const choice = await ui.select(row.label, [UNSET, CUSTOM, ...options.models]);
			if (choice === undefined) continue;
			if (choice === CUSTOM) {
				const typed = (await ui.input("Model as provider/model-id", "provider/model-id"))?.trim();
				if (!typed) continue;
				value = typed;
			} else value = choice === UNSET ? undefined : choice;
		} else if (row.kind === "number") {
			const hint = `${row.unit ? `${row.unit}, ` : ""}at least ${row.min}${row.zero ? `; 0 = ${row.zero}` : ""}; blank = default`;
			const typed = await ui.input(`${row.label} (${hint})`, String(valueAt(settings, row.path)));
			if (typed === undefined) continue;
			if (typed.trim() === "") value = undefined;
			else {
				const number = Number(typed.trim().replace(/^\$/, ""));
				if (!Number.isFinite(number) || (row.integer && !Number.isInteger(number))) {
					ui.notify(`"${typed.trim()}" is not a ${row.integer ? "whole " : ""}number. Nothing changed.`, "warning");
					continue;
				}
				value = number;
			}
		} else {
			const typed = await ui.input(`${row.label} (provider names separated by commas; blank = none)`, "openai, anthropic-apikey");
			if (typed === undefined) continue;
			const names = typed.split(/[\s,]+/).filter(Boolean);
			value = names.length > 0 ? names : undefined;
		}

		const problem = updateSettingsFile(file, row.path, value);
		if (problem) ui.notify(`Not saved: ${problem}`, "warning");
		else changed.add(row.path[0]!);
	}
}
