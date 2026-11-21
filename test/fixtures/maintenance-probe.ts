// Stands in for pi-session-maintenance's host control channel and records what it is asked.
import { appendFileSync } from "node:fs";

export default function maintenanceProbe(pi: any) {
	pi.events.on("pi-session-maintenance:control:v1", (request: any) => {
		const file = process.env.MAINTENANCE_PROBE_LOG;
		if (file) {
			appendFileSync(
				file,
				`${JSON.stringify({ subagent: process.env.PI_SUBAGENT_ID ?? null, operation: request.operation, settings: request.settings })}\n`,
			);
		}
		request.result = Promise.resolve({ enabled: false });
	});
}
