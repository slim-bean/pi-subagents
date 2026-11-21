/**
 * pi-subagents: persistent research subagents.
 *
 * The same extension loads in every pi process and takes one of two roles,
 * decided by the session it is attached to:
 *
 *   requester  an ordinary session. Gets the subagent_* tools, the widget and
 *              completion notices, and drives child processes via the Supervisor.
 *   subagent   a session seeded with an identity entry, whether it runs in a
 *              child process or a person has entered it. Gets the research
 *              instructions and no subagent tools, so subagents cannot nest.
 *
 * Nothing is started from the factory. The Supervisor lives per process (see
 * global.ts) and outlives this instance across /reload and session switches.
 */
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { loadSettings } from "./config.ts";
import { formatCost, formatDuration, outcomeLabel, snapshotLine } from "./format.ts";
import { currentSupervisor, getSupervisor } from "./global.ts";
import { refusal } from "./guard.ts";
import { ENV_SUBAGENT_ID, makeLauncher } from "./launch.ts";
import { researchInstructions } from "./prompt.ts";
import { findIdentity } from "./role.ts";
import { seedSession } from "./seed.ts";
import { Store } from "./store.ts";
import { type EndEvent, Supervisor } from "./supervisor.ts";
import { registerTools } from "./tools.ts";
import { type Identity, NOTICE_TYPE, type NotifyMode, type Settings, type SubagentRef } from "./types.ts";

const WIDGET = "subagents";
const STATUS = "subagents";
/** pi-session-maintenance's host control channel. */
const MAINTENANCE_CONTROL = "pi-session-maintenance:control:v1";

export default function piSubagents(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined; // Valid from session_start until session_shutdown.
	let identity: Identity | undefined;
	let attached: Supervisor | undefined;
	let toolsRegistered = false;
	let notifyOverride: NotifyMode | undefined;
	let problems: string[] = [];
	let shownProblems = "";
	let ticker: NodeJS.Timeout | undefined;
	let foregroundLock: SubagentRef | undefined;
	let maintenanceOff = false;
	let readOnly = true;

	const newStore = () => new Store(join(getAgentDir(), "subagents"));
	const supervisor = (): Supervisor =>
		getSupervisor(() => {
			const store = newStore();
			return new Supervisor(store, makeLauncher(store), seedSession);
		});

	const attach = (sup: Supervisor) => {
		detach();
		attached = sup;
		sup.on("change", refreshWidget);
		sup.on("end", onEnd);
		refreshWidget();
	};
	const detach = () => {
		attached?.off("change", refreshWidget);
		attached?.off("end", onEnd);
		attached = undefined;
	};

	/** Settings are re-read on use, so edits apply without a reload. */
	const settings = (context: ExtensionContext): Settings => {
		const loaded = loadSettings(getAgentDir(), context.isProjectTrusted() ? join(context.cwd, CONFIG_DIR_NAME) : undefined);
		problems = loaded.problems;
		const effective = notifyOverride ? { ...loaded.settings, notify: notifyOverride } : loaded.settings;
		currentSupervisor()?.configure(effective);
		return effective;
	};

	const host = {
		supervisor,
		settings,
		problems: () => problems,
		identity: () => identity,
		cwd: () => ctx?.cwd,
		setNotify: (mode: NotifyMode) => {
			notifyOverride = mode;
		},
	};

	registerCommands(pi, host);

	// ---- widget -----------------------------------------------------------

	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};

	const refreshWidget = () => {
		if (!ctx?.hasUI || !attached) return;
		const live = attached.live(ctx.cwd);
		ctx.ui.setWidget(WIDGET, live.length > 0 ? live.map((snapshot) => snapshotLine(snapshot)) : undefined);
		if (live.some((snapshot) => snapshot.state !== "idle")) {
			if (!ticker) {
				// Elapsed times advance even when the subagent is quiet.
				ticker = setInterval(refreshWidget, 1000);
				ticker.unref?.();
			}
		} else stopTicker();
	};

	// ---- completion notices -----------------------------------------------

	const tellModel = (lines: string[], interrupt: boolean) => {
		pi.sendMessage(
			{ customType: NOTICE_TYPE, content: lines.join("\n"), display: true },
			interrupt ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
		);
	};

	const onEnd = ({ record, assignment, result }: EndEvent) => {
		if (!ctx || !attached || record.cwd !== ctx.cwd) return;
		refreshWidget();
		if (!assignment.background) return; // A waiting tool call already has the report.
		const summary = `${result.id} "${result.title}" ${outcomeLabel(result)} · ${result.turns} turns · ${formatDuration(result.durationMs)} · ${formatCost(result.usage.cost)}`;
		if (ctx.hasUI) ctx.ui.notify(summary, result.outcome === "completed" ? "info" : "warning");
		// Only the session that asked gets a model-facing notice, and only once.
		if (identity || assignment.collected) return;
		if (assignment.requester.sessionId !== ctx.sessionManager.getSessionId()) return;
		const mode = settings(ctx).notify;
		if (mode === "off" || !attached.noticed({ cwd: record.cwd, id: record.id }, assignment.n)) return;
		tellModel(
			[`Subagent ${summary}.`, `Call subagent_wait with ids ["${result.id}"] to read its report.`],
			mode === "interrupt",
		);
	};

	/** Reports that finished while this session was not the active one. */
	const announceMissed = (context: ExtensionContext, sup: Supervisor) => {
		if (settings(context).notify === "off") return;
		const me = context.sessionManager.getSessionId();
		const lines: string[] = [];
		for (const snapshot of sup.list(context.cwd)) {
			const assignment = snapshot.assignment;
			if (snapshot.state !== "idle" || !assignment?.outcome || !assignment.background) continue;
			if (assignment.collected || assignment.noticed || assignment.requester.sessionId !== me) continue;
			if (sup.noticed({ cwd: context.cwd, id: snapshot.id }, assignment.n)) {
				lines.push(`- ${snapshot.id} "${snapshot.title}": ${outcomeLabel(assignment)}`);
			}
		}
		if (lines.length > 0) {
			tellModel(["Background subagent assignments finished while this session was away:", ...lines, "Call subagent_wait to read their reports."], false);
		}
	};

	// ---- roles ------------------------------------------------------------

	const startRequester = (context: ExtensionContext) => {
		if (!toolsRegistered) {
			registerTools(pi, host);
			toolsRegistered = true;
		}
		const sup = supervisor();
		sup.configure(settings(context));
		attach(sup);
		announceMissed(context, sup);
		const report = problems.join("\n");
		if (report && report !== shownProblems && context.hasUI) {
			shownProblems = report;
			context.ui.notify(`pi-subagents settings:\n${report}`, "warning");
		}
	};

	const startSubagent = (context: ExtensionContext, who: Identity) => {
		readOnly = settings(context).readOnly;
		if (context.hasUI) context.ui.setStatus(STATUS, `subagent ${who.id}`);
		// A supervisor may already exist in this process (the person entered from a
		// requester session): keep the widget and notifications for the others alive.
		const sup = currentSupervisor();
		if (sup) attach(sup);
		if (process.env[ENV_SUBAGENT_ID] === who.id) return; // Child process: the requester's pi holds the lock.
		// A person has this session open. Claim it so no process starts the subagent underneath them.
		const ref = { cwd: who.cwd, id: who.id };
		const lock = newStore().acquireLock(ref.cwd, ref.id, "foreground");
		if (lock.ok) foregroundLock = ref;
		else if (context.hasUI) {
			context.ui.notify(
				`Subagent ${who.id} is running in another pi process (pid ${lock.owner.pid}). Typing here could corrupt its session.`,
				"warning",
			);
		}
	};

	/**
	 * Subagent sessions must not trigger idle maintenance (knowledge review,
	 * summaries, rotation): it would spend unattended and act on research
	 * transcripts. `configure` is local to this runtime; the workspace-wide
	 * `suspend` would also pause the person's own sessions.
	 */
	const disableMaintenance = async () => {
		if (maintenanceOff) return;
		const request: { protocol: 1; operation: "configure"; settings: { enabled: false }; result?: Promise<unknown> } = {
			protocol: 1,
			operation: "configure",
			settings: { enabled: false },
		};
		pi.events.emit(MAINTENANCE_CONTROL, request);
		if (!request.result) {
			maintenanceOff = true; // pi-session-maintenance is not loaded: nothing to switch off.
			return;
		}
		try {
			await request.result;
			maintenanceOff = true;
		} catch {
			// Its coordinator is not attached yet (it loads after us). Retried before the next run.
		}
	};

	pi.on("session_start", (_event, context) => {
		ctx = context;
		identity = findIdentity(context.sessionManager.getEntries());
		if (identity) {
			startSubagent(context, identity);
			void disableMaintenance();
		} else startRequester(context);
	});

	pi.on("before_agent_start", async (event) => {
		if (!identity) return;
		// Every session_start handler has run by now, whatever the extension load order.
		await disableMaintenance();
		event.systemPromptOptions.sections.subagent = researchInstructions(identity);
	});

	pi.on("tool_call", (event, context) => {
		if (!identity || !readOnly) return;
		const reason = refusal(event.toolName, event.input, context.cwd, identity);
		if (reason) return { block: true, reason };
	});

	pi.on("session_shutdown", async (event) => {
		const context = ctx;
		ctx = undefined; // Supervisor events during teardown must not touch a dying session.
		stopTicker();
		detach();
		if (context?.hasUI) {
			context.ui.setWidget(WIDGET, undefined);
			context.ui.setStatus(STATUS, undefined);
		}
		if (foregroundLock) {
			newStore().releaseLock(foregroundLock.cwd, foregroundLock.id);
			foregroundLock = undefined;
		}
		// Subagents keep working across /reload and session switches, but never after pi quits.
		if (event.reason === "quit") await currentSupervisor()?.shutdownAll();
	});
}
