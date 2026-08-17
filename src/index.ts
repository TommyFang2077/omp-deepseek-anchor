import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import {
	BOOTSTRAP_TOOLS,
	DSH_ANCHOR_TEXT,
	bootstrapPayload,
	filterAvailable,
	formatStatus,
	hasPromotionSignal,
	isBootstrapTool,
	isDeepSeekModel,
	parseMaxTokens,
	prependAnchor,
	readEnvText,
	resolveResidentTools,
} from "./anchor";
import type { AnchorMode, AnchorSnapshot } from "./anchor";

export const STATUS_COMMAND = "deepseek-anchor-status";

export default function deepSeekAnchor(
	pi: ExtensionAPI,
	mode: AnchorMode =
		process.env.OMP_DEEPSEEK_ANCHOR_MODE === "dsh" ? "dsh" : "safe",
) {
	// Config validation: mirror dsh-routing-suite's schema-defaults discipline,
	// adapted to env-var configuration. Invalid values warn once and fall back
	// to safe defaults instead of failing silently.
	const rawMode = process.env.OMP_DEEPSEEK_ANCHOR_MODE;
	if (rawMode !== undefined && rawMode !== "safe" && rawMode !== "dsh") {
		pi.logger.warn(
			`[omp-deepseek-anchor] Invalid OMP_DEEPSEEK_ANCHOR_MODE="${rawMode}"; expected "safe" or "dsh". Using safe mode.`,
		);
	}
	const rawMaxTokens = process.env.OMP_DEEPSEEK_ANCHOR_MAX_TOKENS;
	if (rawMaxTokens !== undefined && rawMaxTokens.trim() !== "") {
		const parsed = parseMaxTokens(rawMaxTokens);
		if (parsed === undefined) {
			pi.logger.warn(
				`[omp-deepseek-anchor] Invalid OMP_DEEPSEEK_ANCHOR_MAX_TOKENS="${rawMaxTokens}"; expected a positive integer. Feature disabled.`,
			);
		}
	}

	let onceGuidanceShown = mode === "dsh" || !!rawMode;

	const maxTokens = parseMaxTokens();
	const zeroTools =
		mode === "dsh" && process.env.OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS === "1";
	const anchorText = readEnvText("OMP_DEEPSEEK_ANCHOR_TEXT", DSH_ANCHOR_TEXT);

	let toolsNarrowed = false;
	let minimalPromptActive = false;
	let restoreTools: string[] | undefined;
	let residentApplied = false;
	let warnedMissingTools = false;
	let loggedActivation = false;
	const warnedMissingResident = new Set<string>();

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

	function warnMissingResident(requested: string[], available: string[]): void {
		const have = new Set(available);
		for (const name of requested) {
			if (have.has(name) || warnedMissingResident.has(name)) continue;
			warnedMissingResident.add(name);
			pi.logger.warn(
				`[omp-deepseek-anchor] Resident tool "${name}" is not part of this session's catalog and was skipped.`,
			);
		}
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
		let next = full;
		if (mode === "dsh") {
			const requested = resolveResidentTools();
			if (full.length > 0) warnMissingResident(requested, full);
			next = filterAvailable(requested, full);
		}
		residentApplied = true;
		await pi.setActiveTools(next.length > 0 ? next : full);
		toolsNarrowed = false;
		restoreTools = undefined;
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
		const requested = resolveResidentTools();
		if (available.length > 0) warnMissingResident(requested, available);
		const resident = filterAvailable(requested, available);
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
		if (!loggedActivation) {
			loggedActivation = true;
			pi.logger.info(
				"[omp-deepseek-anchor] Bootstrap active: fresh DeepSeek session narrowed to bash+edit; run /deepseek-anchor-status for state.",
			);
		}
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

	// Read-only status surface (analogue of dsh-routing-suite's status API):
	// observe mode, phase, and current catalog without touching session state.
	pi.registerCommand(STATUS_COMMAND, {
		description:
			"Show DeepSeek Anchor runtime state (mode, phase, tool catalog)",
		handler: async (_args, ctx) => {
			const model = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "unavailable";
			const snapshot: AnchorSnapshot = {
				mode,
				model,
				promoted: hasPromotionSignal(ctx),
				active: isDeepSeekModel(ctx.model) && !hasPromotionSignal(ctx),
				toolsNarrowed,
				minimalPromptActive,
				zeroTools,
				maxTokens,
				residentTools:
					mode === "dsh" ? resolveResidentTools() : [...BOOTSTRAP_TOOLS],
				activeTools: pi.getActiveTools(),
			};
			const text = formatStatus(snapshot);
			if (ctx.ui?.notify) ctx.ui.notify(text, "info");
			else pi.logger.info(text);
		},
	});
}