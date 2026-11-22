/**
 * Settings: `<agent dir>/subagents.json`, overridden per project by
 * `<cwd>/.pi/subagents.json` when the project is trusted. All keys optional.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

export const CONFIG_FILE = "subagents.json";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const NOTIFY_MODES = ["interrupt", "next", "off"] as const;

export interface LoadedSettings {
	settings: Settings;
	/** Human-readable problems; invalid values are ignored rather than applied. */
	problems: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Apply one settings object on top of `base`, collecting problems instead of throwing. */
export function applySettings(raw: unknown, base: Settings, source: string, problems: string[]): Settings {
	if (!isObject(raw)) {
		problems.push(`${source}: expected a JSON object`);
		return base;
	}
	const next: Settings = { ...base, limits: { ...base.limits } };
	const number = (key: string, value: unknown, min: number): number | undefined => {
		if (typeof value === "number" && Number.isFinite(value) && value >= min) return value;
		problems.push(`${source}: "${key}" must be a number >= ${min}`);
		return undefined;
	};
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "model":
				if (typeof value === "string" && /^[^/\s]+\/\S+$/.test(value)) next.model = value;
				else problems.push(`${source}: "model" must look like "provider/model-id"`);
				break;
			case "thinking":
				if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) next.thinking = value;
				else problems.push(`${source}: "thinking" must be one of ${THINKING_LEVELS.join(", ")}`);
				break;
			case "notify":
				if (typeof value === "string" && (NOTIFY_MODES as readonly string[]).includes(value)) {
					next.notify = value as Settings["notify"];
				} else problems.push(`${source}: "notify" must be one of ${NOTIFY_MODES.join(", ")}`);
				break;
			case "maxConcurrent":
				next.maxConcurrent = Math.floor(number(key, value, 1) ?? next.maxConcurrent);
				break;
			case "idleMinutes":
				next.idleMinutes = number(key, value, 0) ?? next.idleMinutes;
				break;
			case "reportMaxChars":
				next.reportMaxChars = Math.floor(number(key, value, 1000) ?? next.reportMaxChars);
				break;
			case "startTimeoutSeconds":
				next.startTimeoutSeconds = number(key, value, 5) ?? next.startTimeoutSeconds;
				break;
			case "readOnly":
				if (typeof value === "boolean") next.readOnly = value;
				else problems.push(`${source}: "readOnly" must be true or false`);
				break;
			case "forwardAuth":
				if (Array.isArray(value) && value.every((item) => typeof item === "string" && /^[A-Za-z0-9._-]+$/.test(item))) {
					next.forwardAuth = [...value];
				} else problems.push(`${source}: "forwardAuth" must be a list of provider names`);
				break;
			case "limits":
				if (!isObject(value)) {
					problems.push(`${source}: "limits" must be an object`);
					break;
				}
				for (const [limit, amount] of Object.entries(value)) {
					if (limit === "maxTurns" || limit === "maxMinutes" || limit === "maxCostUsd") {
						next.limits[limit] = number(`limits.${limit}`, amount, 0) ?? next.limits[limit];
					} else problems.push(`${source}: unknown key "limits.${limit}"`);
				}
				break;
			default:
				problems.push(`${source}: unknown key "${key}"`);
		}
	}
	return next;
}

function readJson(file: string, problems: string[]): unknown | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined; // Missing files are normal.
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		problems.push(`${file}: ${(error as Error).message}`);
		return undefined;
	}
}

/** `projectConfigDir` is the project's `.pi` directory, or undefined when the project is not trusted. */
export function loadSettings(agentDir: string, projectConfigDir: string | undefined): LoadedSettings {
	const problems: string[] = [];
	let settings = DEFAULT_SETTINGS;
	for (const dir of [agentDir, projectConfigDir]) {
		if (!dir) continue;
		const file = join(dir, CONFIG_FILE);
		const raw = readJson(file, problems);
		if (raw !== undefined) settings = applySettings(raw, settings, file, problems);
	}
	return { settings, problems };
}
