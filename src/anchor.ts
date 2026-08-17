import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * Pure anchor logic for omp-deepseek-anchor, separated from the extension
 * wiring (src/index.ts) so every transform is unit-testable without a pi
 * harness. Mirror of dsh-routing-suite's router.mjs / index.ts split.
 */

/**
 * OMP analogue of DSH Minimal's real pair (`bash` + `str_replace_editor`).
 * Issue #11 of dsh-anchored-standard measured this schema anchoring 5/5 at
 * the adapter-default maxTokens; standard-family `bash`+`read` fell
 * standard-like 11/11.
 */
export const BOOTSTRAP_TOOLS = ["bash", "edit"] as const;
export const DSH_MINIMAL_SYSTEM = "You are a helpful software engineer assistant.";

export const BOOTSTRAP_TOOL_SCHEMAS: Record<
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
export const RESIDENT_FALLBACK_TOOLS = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"glob",
	"todo",
	"ask",
] as const;

export type AnchorMode = "safe" | "dsh";

export function isBootstrapTool(name: string): boolean {
	return (BOOTSTRAP_TOOLS as readonly string[]).includes(name);
}

export type RequestPayload = Record<string, unknown>;
export function isDeepSeekModel(model: ExtensionContext["model"]): boolean {
	if (!model) return false;
	return /deepseek/i.test(`${model.provider}/${model.id}`);
}

/**
 * Promotion signal: the first durable assistant message (dsh `promoteOn:
 * "either"`). Guarded against missing session manager surfaces so startup
 * paths that have not bound one yet fail open instead of throwing.
 */
export function hasPromotionSignal(
	ctx: Pick<ExtensionContext, "sessionManager">,
): boolean {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	return branch.some(
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

export function readEnvText(name: string, fallback: string): string {
	const raw = process.env[name];
	return typeof raw === "string" && raw.trim().length > 0 ? raw : fallback;
}

export function resolveResidentTools(): string[] {
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

export function filterAvailable(names: readonly string[], available: string[]): string[] {
	const have = new Set(available);
	return [...new Set(names)].filter((name) => have.has(name));
}

export function compactBootstrapTool(
	entry: RequestPayload,
	name: string,
): RequestPayload[] {
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

/**
 * Transform the first-request wire payload: optional output cap, bootstrap
 * tool narrowing (or zero-tool empty catalog), and — in dsh mode — the
 * Minimal persona with compact schemas. Non-object payloads pass through
 * unchanged. Re-applying the transform to an already-bootstrapped payload is
 * a no-op by construction: the tools array already contains only bootstrap
 * entries and the system fields are already Minimal (dsh-routing-suite's
 * "reapplying replaces only its own section" property, applied to payloads).
 */
export function bootstrapPayload(
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

/**
 * Read-only status snapshot rendered by the `/deepseek-anchor-status`
 * command (analogue of dsh-routing-suite's read-only status API). All fields
 * are derived from live state; nothing here mutates the session.
 */
export interface AnchorSnapshot {
	mode: AnchorMode;
	model: string;
	/** Session has a durable assistant message (already promoted). */
	promoted: boolean;
	/** Anchor is engaged for this session (DeepSeek model + fresh). */
	active: boolean;
	toolsNarrowed: boolean;
	minimalPromptActive: boolean;
	zeroTools: boolean;
	maxTokens?: number;
	residentTools: string[];
	activeTools: string[];
}

export function formatStatus(snapshot: AnchorSnapshot): string {
	const phase = !snapshot.active
		? "inactive"
		: snapshot.promoted
			? "promoted"
			: "bootstrap";
	return [
		`[omp-deepseek-anchor] mode=${snapshot.mode} phase=${phase}`,
		`  model: ${snapshot.model}`,
		`  anchor: ${snapshot.active ? "active" : "inactive"}`,
		`  bootstrap narrowed: ${snapshot.toolsNarrowed}`,
		`  minimal persona: ${snapshot.minimalPromptActive}`,
		snapshot.zeroTools ? "  zero-tool anchor: on" : "  zero-tool anchor: off",
		snapshot.maxTokens
			? `  first-request cap: ${snapshot.maxTokens}`
			: "  first-request cap: off",
		`  resident tools: ${snapshot.residentTools.join(", ") || "(none)"}`,
		`  active tools: ${snapshot.activeTools.join(", ") || "(none)"}`,
	].join("\n");
}