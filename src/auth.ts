/**
 * Collect the API keys this pi process has already resolved for the providers
 * the user listed in `forwardAuth`, to hand to a subagent at startup (see
 * handoff.ts). pi caches a resolved key command for the life of the process,
 * so this does not run the command again.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function forwardedKeys(ctx: ExtensionContext, providers: readonly string[]): Promise<Record<string, string> | undefined> {
	const keys: Record<string, string> = {};
	for (const provider of providers) {
		try {
			const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (key) keys[provider] = key;
		} catch {
			// Unknown provider or unresolved key: the child resolves it itself.
		}
	}
	return Object.keys(keys).length > 0 ? keys : undefined;
}
