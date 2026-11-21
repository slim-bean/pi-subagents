/**
 * One Supervisor per pi process, kept on globalThis so running subagents
 * survive /reload and session switches (both replace the extension instance).
 *
 * A supervisor created by older code keeps running while an assignment is in
 * flight; swapping it would lose that work. Otherwise the next caller replaces
 * it (warm idle processes are just a cache and are ended), so code changes
 * take effect after a reload without restarting pi.
 */
import { SUPERVISOR_API, type Supervisor } from "./supervisor.ts";

const KEY = Symbol.for("pi-subagents.supervisor.v1");
const EXIT_HOOK = Symbol.for("pi-subagents.exit-hook.v1");
/** Changes whenever this module is evaluated again, i.e. after a code reload. */
const CODE_ID = Symbol("pi-subagents.code");

interface Slot {
	supervisor: Supervisor;
	codeId: symbol;
}

type Globals = typeof globalThis & { [KEY]?: Slot; [EXIT_HOOK]?: boolean };

export function currentSupervisor(): Supervisor | undefined {
	return (globalThis as Globals)[KEY]?.supervisor;
}

export function getSupervisor(create: () => Supervisor): Supervisor {
	const globals = globalThis as Globals;
	const slot = globals[KEY];
	if (slot && slot.supervisor.api === SUPERVISOR_API && (slot.codeId === CODE_ID || slot.supervisor.hasActiveWork())) {
		return slot.supervisor;
	}
	const fresh = create();
	if (slot) {
		for (const [file, target] of slot.supervisor.returnTo) fresh.returnTo.set(file, target);
		slot.supervisor.removeAllListeners();
		// The old processes must be gone (and their locks released) before the new supervisor starts any.
		fresh.holdUntil(slot.supervisor.shutdownAll(3000));
	}
	globals[KEY] = { supervisor: fresh, codeId: CODE_ID };
	if (!globals[EXIT_HOOK]) {
		globals[EXIT_HOOK] = true;
		// Last resort if pi exits without a graceful session_shutdown. Looks the
		// supervisor up at exit time, so it always reaches the current one.
		process.on("exit", () => (globalThis as Globals)[KEY]?.supervisor.killAllSync());
	}
	return fresh;
}
