import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const BOOTSTRAP_TOOLS = ["bash", "read"] as const;
const BOOTSTRAP_MAX_TOKENS = 1024;
const DSH_MINIMAL_SYSTEM = "You are a helpful software engineer assistant.";
type AnchorMode = "safe" | "dsh";

function isBootstrapTool(name: string): boolean {
	return name === "bash" || name === "read";
}

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

function bootstrapPayload(
	payload: unknown,
	api: string | undefined,
	mode: AnchorMode,
	narrowTools: boolean,
): unknown {
	const capped = capOutputTokens(payload, api);
	if (typeof capped !== "object" || capped === null || Array.isArray(capped))
		return capped;

	const request = capped as RequestPayload;
	if (!Array.isArray(request.tools)) return capped;
	const tools = narrowTools
		? request.tools.flatMap((tool) => {
				if (typeof tool === "string") return isBootstrapTool(tool) ? [tool] : [];
				if (typeof tool !== "object" || tool === null || Array.isArray(tool))
					return [];

				const entry = tool as RequestPayload;
				const nested = entry.function;
				const nestedFunction =
					typeof nested === "object" && nested !== null && !Array.isArray(nested)
						? (nested as RequestPayload)
						: undefined;
				const name =
					typeof entry.name === "string"
						? entry.name
						: typeof nestedFunction?.name === "string"
							? nestedFunction.name
							: undefined;
				if (name === undefined || !isBootstrapTool(name)) return [];
				if (mode === "safe") return [tool];

				const description =
					name === "bash"
						? "Run a command in a persistent shell."
						: "Read a text file.";
				const parameters = {
					type: "object",
					properties:
						name === "bash"
							? { command: { type: "string" } }
							: { path: { type: "string" } },
					required: [name === "bash" ? "command" : "path"],
				};
				return nestedFunction
					? [{ ...entry, function: { ...nestedFunction, description, parameters } }]
					: [{ ...entry, description, parameters }];
			})
		: request.tools;

	const transformed: RequestPayload = { ...request, tools };
	if (mode !== "dsh") return transformed;
	if (api?.includes("responses") || "instructions" in transformed)
		transformed.instructions = DSH_MINIMAL_SYSTEM;
	if (api?.includes("anthropic") || "system" in transformed)
		transformed.system = DSH_MINIMAL_SYSTEM;
	if (Array.isArray(transformed.messages)) {
		const messages = transformed.messages.filter((message) => {
			if (typeof message !== "object" || message === null) return true;
			const role = (message as RequestPayload).role;
			return role !== "system" && role !== "developer";
		});
		transformed.messages = [
			{ role: "system", content: DSH_MINIMAL_SYSTEM },
			...messages,
		];
	}
	return transformed;
}

export default function deepSeekAnchor(
	pi: ExtensionAPI,
	mode: AnchorMode =
		process.env.OMP_DEEPSEEK_ANCHOR_MODE === "dsh" ? "dsh" : "safe",
) {
	let onceGuidanceShown = mode === "dsh" || !!process.env.OMP_DEEPSEEK_ANCHOR_MODE;

	let toolsNarrowed = false;
	let minimalPromptActive = false;
	let restoreTools: string[] | undefined;
	let warnedMissingTools = false;

	function showDshGuidanceOnce() {
		if (onceGuidanceShown) return;
		if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
		onceGuidanceShown = true;
		console.error(
			"[omp-deepseek-anchor] Safe mode active (default). To enable DSH-compatible Minimal persona persistence:\n" +
			"  Add to ~/.bashrc or shell config: export OMP_DEEPSEEK_ANCHOR_MODE=dsh\n" +
			"  Then restart the shell and create a new OMP session.",
		);
	}
	async function promoteTools(): Promise<void> {
		if (!toolsNarrowed || !restoreTools) return;
		await pi.setActiveTools(restoreTools);
		toolsNarrowed = false;
		restoreTools = undefined;
	}

	async function promotePrompt(): Promise<void> {
		minimalPromptActive = false;
	}

	async function sync(ctx: ExtensionContext): Promise<void> {
		const shouldBootstrap =
			isDeepSeekModel(ctx.model) && !hasPromotionSignal(ctx);
		if (!shouldBootstrap) {
			await promoteTools();
			await promotePrompt();
			return;
		}

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
			if (toolsNarrowed) await promoteTools();
			if (minimalPromptActive) await promotePrompt();
			return;
		}

		if (toolsNarrowed) {
			restoreTools = [...new Set([...(restoreTools ?? []), ...activeTools])];
			if (activeTools.some((name) => !isBootstrapTool(name)))
				await pi.setActiveTools([...bootstrapTools]);
			return;
		}

		restoreTools = activeTools;
		await pi.setActiveTools([...bootstrapTools]);
		toolsNarrowed = true;
		minimalPromptActive = true;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isDeepSeekModel(ctx.model) && !hasPromotionSignal(ctx)) {
			showDshGuidanceOnce();
		}
		await sync(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => sync(ctx));
	pi.on("session_branch", async (_event, ctx) => sync(ctx));
	pi.on("session_tree", async (_event, ctx) => sync(ctx));

	pi.on("before_agent_start", async (_event, ctx) => sync(ctx));

	pi.on("before_provider_request", async (event, ctx) => {
		if (toolsNarrowed) await sync(ctx);
		if (!minimalPromptActive || !isDeepSeekModel(ctx.model)) return event.payload;
		return bootstrapPayload(event.payload, ctx.model?.api, mode, toolsNarrowed);
	});

	pi.on("tool_call", async (event) => {
		const repairInput =
			mode === "dsh" &&
			isBootstrapTool(event.toolName) &&
			!("i" in event.input && typeof event.input.i === "string")
				? { ...event.input, i: "Bootstrap repository inspection" }
				: undefined;
		await promoteTools();
		return repairInput ? { input: repairInput } : undefined;
	});
	pi.on("agent_end", async () => {
		await promoteTools();
		await promotePrompt();
	});
}
