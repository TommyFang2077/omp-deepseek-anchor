import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const BOOTSTRAP_TOOLS = ["bash", "read"] as const;
const BOOTSTRAP_MAX_TOKENS = 1024;

type RequestPayload = Record<string, unknown>;
export function isDeepSeekModel(model: ExtensionContext["model"]): boolean {
	if (!model) return false;
	return /deepseek/i.test(`${model.provider}/${model.id}`);
}

export function hasPromotionSignal(
	ctx: Pick<ExtensionContext, "sessionManager">,
): boolean {
	return ctx.sessionManager
		.getBranch()
		.some(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
}

export function capOutputTokens(
	payload: unknown,
	api: string | undefined,
	limit = BOOTSTRAP_MAX_TOKENS,
): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload))
		return payload;

	// Provider request hooks expose a wire payload with provider-specific fields.
	const request = payload as RequestPayload;
	let field = api?.includes("responses") ? "max_output_tokens" : "max_tokens";
	for (const candidate of [
		"max_output_tokens",
		"max_completion_tokens",
		"max_tokens",
	]) {
		if (candidate in request) {
			field = candidate;
			break;
		}
	}

	const current = request[field];
	const capped =
		typeof current === "number" && Number.isFinite(current)
			? Math.min(current, limit)
			: limit;

	return { ...request, [field]: capped };
}

export default function deepSeekAnchor(pi: ExtensionAPI) {
	let bootstrapping = false;
	let restoreTools: string[] | undefined;
	let warnedMissingTools = false;

	async function promote(): Promise<void> {
		if (!bootstrapping || !restoreTools) return;
		await pi.setActiveTools(restoreTools);
		bootstrapping = false;
		restoreTools = undefined;
	}

	async function sync(ctx: ExtensionContext): Promise<void> {
		const shouldBootstrap =
			isDeepSeekModel(ctx.model) && !hasPromotionSignal(ctx);
		if (!shouldBootstrap) {
			await promote();
			return;
		}
		if (bootstrapping) return;

		const activeTools = pi.getActiveTools();
		const bootstrapTools = BOOTSTRAP_TOOLS.filter((name) =>
			activeTools.includes(name),
		);
		if (bootstrapTools.length !== BOOTSTRAP_TOOLS.length) {
			if (!warnedMissingTools) {
				warnedMissingTools = true;
				pi.logger.warn(
					"DeepSeek anchor disabled: fresh sessions require active bash and read tools",
				);
			}
			return;
		}

		await pi.setActiveTools([...bootstrapTools]);
		restoreTools = activeTools;
		bootstrapping = true;
	}

	pi.on("session_start", async (_event, ctx) => sync(ctx));
	pi.on("session_switch", async (_event, ctx) => sync(ctx));
	pi.on("session_branch", async (_event, ctx) => sync(ctx));
	pi.on("session_tree", async (_event, ctx) => sync(ctx));

	pi.on("before_agent_start", async (_event, ctx) => sync(ctx));

	pi.on("before_provider_request", (event, ctx) => {
		if (!bootstrapping || !isDeepSeekModel(ctx.model)) return event.payload;
		return capOutputTokens(event.payload, ctx.model?.api);
	});

	pi.on("tool_call", async () => promote());
	pi.on("agent_end", async () => promote());
}
