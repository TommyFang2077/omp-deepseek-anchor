import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * OMP analogue of DSH Minimal's real pair (`bash` + `str_replace_editor`).
 * Issue #11 of dsh-anchored-standard measured this schema anchoring 5/5 at
 * the adapter-default maxTokens; standard-family `bash`+`read` fell
 * standard-like 11/11.
 */
const BOOTSTRAP_TOOLS = ["bash", "edit"] as const;
const DSH_MINIMAL_SYSTEM = "You are a helpful software engineer assistant.";

const BOOTSTRAP_TOOL_SCHEMAS: Record<
	(typeof BOOTSTRAP_TOOLS)[number],
	{
		description: string;
		parameters: {
			type: "object";
			properties: Record<string, { type: "string" }>;
			required: string[];
		};
	}
> = {
	bash: {
		description: "Run a command in a persistent shell.",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
	edit: {
		description: "Replace a string in a text file.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				old_string: { type: "string" },
				new_string: { type: "string" },
			},
			required: ["path", "old_string", "new_string"],
		},
	},
};

/**
 * Zero-tool anchor notice (port of dsh-anchored-standard's `ANCHOR_TEXT`):
 * prepended to the first request of a fresh DeepSeek session when
 * `OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS=1`, conditioning the "we" trajectory with
 * an explicit "tools not open yet" user turn before the real message.
 */
export const DSH_ANCHOR_TEXT =
	"This round is a test. Tools are not open yet; all tools will open next round.";

/**
 * Resident catalog applied to DeepSeek sessions after promotion (dsh mode).
 * Port of dsh-anchored-standard's post-promotion resident set: the bootstrap
 * pair plus the daily file-work tools, NOT the full catalog. The reference
 * measured that dumping the whole catalog after promotion pulls the
 * trajectory back to standard-like behavior (a flood of `let me` first-lines).
 * Override with `OMP_DEEPSEEK_ANCHOR_RESIDENT=name1,name2,...`.
 */
const RESIDENT_FALLBACK_TOOLS = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"glob",
	"todo",
	"ask",
] as const;

type AnchorMode = "safe" | "dsh";

function isBootstrapTool(name: string): boolean {
	return (BOOTSTRAP_TOOLS as readonly string[]).includes(name);
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
	limit?: number,
): unknown {
	if (limit === undefined) return payload;
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

/**
 * Prepend the zero-tool anchor notice as the first user message of a request.
 * Chat payloads keep a leading system/developer block in place; Responses
 * payloads get a `message` input item. Unrecognized payloads pass through.
 */
export function prependAnchor(payload: unknown, text: string): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload))
		return payload;
	const request = payload as RequestPayload;

	if (Array.isArray(request.messages)) {
		const head: unknown[] = [];
		const rest: unknown[] = [];
		for (const message of request.messages) {
			const role = (message as RequestPayload)?.role;
			if (head.length === 0 && (role === "system" || role === "developer"))
				head.push(message);
			else rest.push(message);
		}
		return {
			...request,
			messages: [...head, { role: "user", content: text }, ...rest],
		};
	}

	if (Array.isArray(request.input)) {
		return {
			...request,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text }],
				},
				...request.input,
			],
		};
	}

	return payload;
}

/**
 * Optional first-request output cap. Unset means the adapter/model default
 * flows through — DSH's `bootstrapMaxTokens` is opt-in for the same reason:
 * the Minimal tool schema anchors without a cap, and a 1024 cap on OMP makes
 * `stopReason: length` look like context overflow and trips snapcompact.
 */
export function parseMaxTokens(
	raw = process.env.OMP_DEEPSEEK_ANCHOR_MAX_TOKENS,
): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readEnvText(name: string, fallback: string): string {
	const raw = process.env[name];
	return typeof raw === "string" && raw.trim().length > 0 ? raw : fallback;
}

function resolveResidentTools(): string[] {
	const raw = process.env.OMP_DEEPSEEK_ANCHOR_RESIDENT;
	if (raw === undefined || raw.trim() === "") return [...RESIDENT_FALLBACK_TOOLS];
	return [
		...new Set(
			raw
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name.length > 0),
		),
	];
}

function filterAvailable(names: readonly string[], available: string[]): string[] {
	const have = new Set(available);
	return [...new Set(names)].filter((name) => have.has(name));
}

function compactBootstrapTool(entry: RequestPayload, name: string): RequestPayload[] {
	if (!isBootstrapTool(name)) return [];
	const schema = BOOTSTRAP_TOOL_SCHEMAS[name as (typeof BOOTSTRAP_TOOLS)[number]];
	const nested = entry.function;
	const nestedFunction =
		typeof nested === "object" && nested !== null && !Array.isArray(nested)
			? (nested as RequestPayload)
			: undefined;
	return nestedFunction
		? [
				{
					...entry,
					function: {
						...nestedFunction,
						description: schema.description,
						parameters: schema.parameters,
					},
				},
			]
		: [{ ...entry, description: schema.description, parameters: schema.parameters }];
}

function bootstrapPayload(
	payload: unknown,
	api: string | undefined,
	mode: AnchorMode,
	narrowTools: boolean,
	zeroTools: boolean,
	limit?: number,
): unknown {
	const capped = capOutputTokens(payload, api, limit);
	if (typeof capped !== "object" || capped === null || Array.isArray(capped))
		return capped;

	const request = capped as RequestPayload;
	if (!Array.isArray(request.tools)) return capped;
	const tools = !narrowTools
		? request.tools
		: zeroTools
			? []
			: request.tools.flatMap((tool) => {
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
					return compactBootstrapTool(entry, name);
				});

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

	const maxTokens = parseMaxTokens();
	const zeroTools =
		mode === "dsh" && process.env.OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS === "1";
	const anchorText = readEnvText("OMP_DEEPSEEK_ANCHOR_TEXT", DSH_ANCHOR_TEXT);

	let toolsNarrowed = false;
	let minimalPromptActive = false;
	let restoreTools: string[] | undefined;
	let residentApplied = false;
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

	/**
	 * Restore the bootstrapped catalog. dsh mode narrows to the resident set
	 * (bootstrap pair + daily tools, `OMP_DEEPSEEK_ANCHOR_RESIDENT` overrides)
	 * instead of the full catalog — the post-promotion trajectory fix from
	 * dsh-anchored-standard. Safe mode keeps the full original catalog.
	 */
	async function promoteTools(): Promise<void> {
		if (!toolsNarrowed || !restoreTools) return;
		const full = restoreTools;
		const next =
			mode === "dsh" ? filterAvailable(resolveResidentTools(), full) : full;
		await pi.setActiveTools(next.length > 0 ? next : full);
		toolsNarrowed = false;
		restoreTools = undefined;
		residentApplied = true;
	}

	async function promotePrompt(): Promise<void> {
		minimalPromptActive = false;
	}

	/**
	 * Enforce the resident catalog on already-promoted DeepSeek sessions
	 * (resume/reload/switch): the phase derives from durable assistant
	 * messages, so a restarted session keeps the resident surface.
	 */
	async function ensureResident(ctx: ExtensionContext): Promise<void> {
		if (residentApplied || mode !== "dsh" || !isDeepSeekModel(ctx.model)) return;
		const available = pi.getAllTools()
			? pi.getAllTools().map((tool) => tool.name)
			: pi.getActiveTools();
		const resident = filterAvailable(resolveResidentTools(), available);
		if (resident.length === 0) return;
		residentApplied = true;
		await pi.setActiveTools(resident);
	}

	async function sync(ctx: ExtensionContext): Promise<void> {
		const shouldBootstrap =
			isDeepSeekModel(ctx.model) && !hasPromotionSignal(ctx);
		if (!shouldBootstrap) {
			await promoteTools();
			await promotePrompt();
			await ensureResident(ctx);
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
					"DeepSeek anchor disabled: fresh sessions require active bash and edit tools",
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

	// Either-signal promotion (port of dsh `promoteOn: "either"`): the first
	// durable assistant message promotes the catalog even when it makes no
	// tool call, so a text-only first reply cannot trap the session in
	// bootstrap forever.
	pi.on("message_end", async (event) => {
		if (!toolsNarrowed) return;
		if (event.message?.role !== "assistant") return;
		await promoteTools();
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (toolsNarrowed) await sync(ctx);
		if (!minimalPromptActive || !isDeepSeekModel(ctx.model)) return event.payload;
		let payload = bootstrapPayload(
			event.payload,
			ctx.model?.api,
			mode,
			toolsNarrowed,
			zeroTools,
			maxTokens,
		);
		if (zeroTools && toolsNarrowed) {
			payload = prependAnchor(payload, anchorText);
		}
		return payload;
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
