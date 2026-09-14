import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Edit-tool observation and reflection.
 *
 * Observation (developer tool, off by default): one JSON line per edit call
 * appended to `<agentDir>/ast-edit.log.jsonl`, so it can be grepped directly.
 *
 * Reflection (on by default): the source of truth is the session itself — the
 * failed `edit` tool results of this extension on the current branch — so no
 * log file is needed. `reflectAfterErrors` decides *when* to reflect (3 new
 * failures by default); the request that follows then covers every failure the
 * last verdict did not, capped at 50 per request. The verdict is queued into
 * the transcript (`ast-edit.reflection`) for the next turn, telling the agent
 * how not to repeat the mistakes. Fully passive: no command triggers it, and
 * the "already reflected through" marker travels with the verdict message.
 *
 * Config lives in the `ast-edit` key of pi's global settings file
 * (`~/.pi/agent/settings.json`); pi ignores and preserves unknown settings
 * keys, so this key round-trips safely.
 *
 * ```jsonc
 * {
 *   "ast-edit": {
 *     "traceEnabled": true,    // optional; OFF by default — developer log of every edit call
 *     "tracePath": "…",       // optional override; default `<agentDir>/ast-edit.log.jsonl`
 *     "autoReflect": false,    // optional; ON by default — reflect after turns with new failures
 *     "reflectModel": {        // optional; defaults to the session's model and level
 *       "providerId": "openrouter",   // provider id; give both ids to switch models
 *       "modelId": "nvidia/nemotron", // model id
 *       "thinkingLevel": "high"       // off|minimal|low|medium|high|xhigh|max
 *     },
 *     "reflectAfterErrors": 3 // trigger: reflect once this many failures piled up;
 *                             // the request then covers all of them, capped at 50
 *   }
 * }
 * ```
 */
const CONFIG_KEY = "ast-edit";

/** pi thinking levels; `off` and non-reasoning models send no level at all. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Model the reflection request runs on; default is the session model. */
export interface ReflectModelConfig {
	/** Provider of the model to run on; give both ids to switch models. */
	providerId?: string;
	modelId?: string;
	/** pi thinking level for the request; default: the provider's own default. */
	thinkingLevel?: ThinkingLevel;
}

export interface TraceConfig {
	/** Developer log of every edit call (default false). */
	traceEnabled: boolean;
	/** Absolute path of the trace log; default `defaultTracePath()`. */
	tracePath?: string;
	/** Reflect on new failed edit calls after each turn (default true). */
	autoReflect: boolean;
	/** Reflection-request model override; default the session model. */
	reflectModel?: ReflectModelConfig;
	/**
	 * Trigger threshold (default 3): once this many failures have piled up since
	 * the last verdict, one reflection covers *all* of them (capped at 50 per
	 * request — the threshold itself is not a batch size).
	 */
	reflectAfterErrors: number;
}

/** Default log file: `<agentDir>/ast-edit.log.jsonl`. */
export function defaultTracePath(): string {
	return join(getAgentDir(), "ast-edit.log.jsonl");
}

export function loadTraceConfig(): TraceConfig {
	const cfg: TraceConfig = { traceEnabled: false, autoReflect: true, reflectAfterErrors: 3 };
	try {
		const settings = JSON.parse(readSettingsFile()) as Record<string, unknown> | undefined;
		const ext = settings?.[CONFIG_KEY];
		if (ext && typeof ext === "object") applyUserConfig(cfg, ext as Record<string, unknown>);
	} catch {
		// no settings file or unparsable JSON: fall back to defaults
	}
	return cfg;
}

/** Overlay the user's `ast-edit` fields; wrong types are ignored. */
function applyUserConfig(cfg: TraceConfig, e: Record<string, unknown>): void {
	if (typeof e.traceEnabled === "boolean") cfg.traceEnabled = e.traceEnabled;
	if (typeof e.tracePath === "string" && e.tracePath.length > 0) cfg.tracePath = e.tracePath;
	if (typeof e.autoReflect === "boolean") cfg.autoReflect = e.autoReflect;
	const reflectModel = parseReflectModel(e.reflectModel);
	if (reflectModel) cfg.reflectModel = reflectModel;
	if (typeof e.reflectAfterErrors === "number" && e.reflectAfterErrors >= 1) {
		cfg.reflectAfterErrors = Math.floor(e.reflectAfterErrors);
	}
}

/**
 * `{ providerId, modelId, thinkingLevel? }`; wrong types and unknown levels are
 * ignored. A usable thinking level is enough on its own — the request then runs
 * on the session model, only at that level.
 */
function parseReflectModel(value: unknown): ReflectModelConfig | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { providerId, modelId, thinkingLevel } = value as Record<string, unknown>;
	const model = modelIds(providerId, modelId);
	const level = isThinkingLevel(thinkingLevel) ? thinkingLevel : undefined;
	if (!model && !level) return undefined;
	return { ...(model ?? {}), ...(level ? { thinkingLevel: level } : {}) };
}

/** `{ providerId, modelId }` when both ids are usable, else `undefined`. */
function modelIds(
	providerId: unknown,
	modelId: unknown,
): { providerId: string; modelId: string } | undefined {
	if (typeof providerId !== "string" || providerId.length === 0) return undefined;
	if (typeof modelId !== "string" || modelId.length === 0) return undefined;
	return { providerId, modelId };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}

function readSettingsFile(): string {
	return readFileSync(join(getAgentDir(), "settings.json"), "utf8");
}

// ---------- developer log (opt-in) ----------

/** One recorded edit-tool call. Compact by design; never full file contents. */
export interface EditTraceRecord {
	ts: number;
	toolCallId: string;
	/** Session id at call time, when available. */
	sessionId?: string;
	/** `provider/id` of the active model, e.g. `ollama-cloud/glm-5.3`, when available. */
	model?: string;
	/** Which backend ran the call. */
	binary: "ast-grep" | "builtin-fallback";
	/** Per-edit summary: mode + the pattern/text at stake (truncated). */
	edits: Array<{ mode: "pattern" | "exact"; text: string }>;
	path: string;
	result: "ok" | "error" | "aborted";
	applied: number;
	preErrors: number;
	postErrors: number;
	/** Up to 500 chars of the error message, when the call failed. */
	error?: string;
	ms: number;
}

/**
 * Append one edit-tool call as a JSON line to the trace log. Opt-in via
 * `traceEnabled`. Never throws — a logging failure must not break an edit.
 * Config is re-read per call, so toggling applies from the next edit.
 */
export function recordEditTrace(record: EditTraceRecord): void {
	const cfg = loadTraceConfig();
	if (!cfg.traceEnabled) return;
	try {
		const path = cfg.tracePath ?? defaultTracePath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch {
		// ignore: telemetry must never break the edit
	}
}

// ---------- reflection input: failed edits on the session branch ----------

/** A failed `edit` call, as found on the current session branch. */
export interface FailedEdit {
	/** Session entry id of the tool result. */
	entryId: string;
	/** Entry timestamp (ISO) — doubles as the coverage marker. */
	ts: string;
	path: string;
	/** Per-edit mode with the pattern/oldText at stake, truncated. */
	edits: string;
	/** The error the agent saw. */
	error: string;
}

/** Message/entry shapes we read (structural; the host types are richer). */
type EntryLike = {
	type?: string;
	id?: string;
	timestamp?: string;
	customType?: string;
	details?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		toolCallId?: string;
		isError?: boolean;
		content?: unknown;
	};
};

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Text of a tool-result content payload. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" ? (part as { text?: string }).text : undefined,
		)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

/** `path` + `edits` of one `edit` tool call argument object. */
function describeEditCall(arguments_: unknown): { path: string; edits: string } {
	const args = (arguments_ ?? {}) as { path?: unknown; edits?: unknown };
	const edits = Array.isArray(args.edits) ? args.edits : [];
	return {
		path: typeof args.path === "string" ? args.path : "(unknown path)",
		edits: edits.map(describeEditSpec).join("  "),
	};
}

/** One edit spec as `mode` + the pattern/oldText at stake. */
function describeEditSpec(raw: unknown): string {
	const spec = (raw ?? {}) as { pattern?: unknown; oldText?: unknown };
	const isPattern = typeof spec.pattern === "string";
	const text = isPattern ? spec.pattern : spec.oldText;
	const shown = typeof text === "string" && text.length > 0 ? `:\`${truncate(text, 120)}\`` : "";
	return `${isPattern ? "pattern" : "exact"}${shown}`;
}

/** Keys another `edit` implementation (pi-hashline-edit) uses; our schema has none of them. */
const FOREIGN_EDIT_KEYS = ["op", "pos", "lines", "end", "span"];

/** `edits` specs, tolerating the JSON-string form some models send instead of an array. */
function editSpecs(arguments_: unknown): Array<Record<string, unknown>> {
	const raw = (arguments_ as { edits?: unknown } | undefined)?.edits;
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	// Mirror the tool's own shim (edit-tool.ts `normalizeEditArgs`): one edit
	// object is accepted as well as an array of them.
	if (typeof value === "object" && value !== null && !Array.isArray(value)) value = [value];
	if (!Array.isArray(value)) return [];
	return value.filter(
		(spec): spec is Record<string, unknown> => typeof spec === "object" && spec !== null,
	);
}

/**
 * Whether an `edit` tool call belongs to this extension. More than one
 * extension can register a tool named "edit" (pi-hashline-edit does) and all of
 * their failures land on the same branch, so reflect only on calls whose
 * arguments match this tool's schema.
 */
function isOurEditCall(arguments_: unknown): boolean {
	const args = (arguments_ ?? {}) as Record<string, unknown>;
	const specs = editSpecs(args);
	const legacy = typeof args.oldText === "string" && typeof args.newText === "string";
	if (!legacy && !specs.some((s) => "oldText" in s || "pattern" in s || "newText" in s)) {
		return false;
	}
	return !specs.some((s) => FOREIGN_EDIT_KEYS.some((key) => key in s));
}

/** `path` + `edits` of each `edit` tool call on the branch, by tool call id. */
function editCallArgs(entries: EntryLike[]): Map<string, { path: string; edits: string }> {
	const out = new Map<string, { path: string; edits: string }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		if (!Array.isArray(entry.message.content)) continue;
		for (const raw of entry.message.content) {
			const call = raw as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (call.type !== "toolCall" || call.name !== "edit" || typeof call.id !== "string") continue;
			if (!isOurEditCall(call.arguments)) continue;
			out.set(call.id, describeEditCall(call.arguments));
		}
	}
	return out;
}

/** Failed `edit` calls on the branch, oldest first. */
export function failedEdits(entries: unknown): FailedEdit[] {
	if (!Array.isArray(entries)) return [];
	const calls = editCallArgs(entries as EntryLike[]);
	const out: FailedEdit[] = [];
	for (const entry of entries as EntryLike[]) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "toolResult") continue;
		if (message.toolName !== "edit" || message.isError !== true) continue;
		if (typeof entry.id !== "string" || typeof entry.timestamp !== "string") continue;
		const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
		// Not one of ours: another tool named "edit", or a call whose entry was
		// compacted away and therefore cannot be proven ours. Neither belongs in
		// the reflection input.
		if (!call) continue;
		out.push({
			entryId: entry.id,
			ts: entry.timestamp,
			path: call.path,
			edits: call.edits,
			error: truncate(contentText(message.content), 500),
		});
	}
	return out;
}

// ---------- reflection request ----------

const MAX_LINE_CHARS = 800;
/**
 * Request-size guard, not a batch size: `reflectAfterErrors` only decides *when*
 * to reflect; the request then carries every failure the last verdict did not
 * cover, capped here so a pile-up (e.g. while the reflection request kept
 * failing) cannot blow up the prompt.
 */
const MAX_FAILURES_PER_REFLECTION = 50;

/** One failure as a single log-ish line. */
export function compactFailure(failure: FailedEdit): string {
	const parts = ["ERROR", failure.path];
	if (failure.edits) parts.push(failure.edits);
	if (failure.error) parts.push(`— ${failure.error}`);
	const line = parts.join("  ");
	// Cap at MAX_LINE_CHARS including the ellipsis.
	return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

const REFLECTION_SYSTEM = `You are an analyzer for pi-ast-edit, an extension that performs structural code edits with ast-grep patterns and exact-text replacements.

You receive a list of FAILED edit-tool calls (one summary line each) recorded inside a pi session. Each line contains: the file path, the per-edit mode ("pattern" or "exact") with the pattern/text at stake, and the error message.

Do:
- Identify recurring failure classes (e.g. ambiguous multi-match patterns, patterns that fail to parse, exact oldText mismatches, replacements that introduce new syntax errors, tool misuse).
- For each class state the likely root cause (agent-side behavior vs tool limitation) and ONE concrete rule the coding agent should follow to avoid repeating it — direct wording the agent can act on.
- If the records show no real failure class, say so briefly.

Do not:
- Quote or reconstruct file contents beyond the short snippets already present in each line.
- Invent failures that are not present.
- Add session-specific narrative or references to anything outside the records.

End with a single bullet list titled "Rules to prevent recurrence" — each item a direct imperative for the agent, max 8 items. Keep the whole answer under 300 words.`;

type SessionManagerLike = { getSessionId?: () => string };

/** The clean request we send: system prompt plus one digests-only user message. */
type ReflectionContext = {
	systemPrompt?: string;
	messages: Array<{ role: string; content: string }>;
};

type ReflectionReply = {
	content?: Array<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
};

/** Minimal shape of pi's ModelRegistry facade (extensions get the real one). */
export type ModelRegistryLike = {
	complete(
		model: unknown,
		context: ReflectionContext,
		options?: { signal?: AbortSignal; reasoning?: ThinkingLevel },
	): Promise<ReflectionReply>;
	/**
	 * The facade's runtime, when present: only the simple request path
	 * (`completeSimple`) maps a pi thinking level onto the provider's own option
	 * (`reasoningEffort`, `thinking`, …). `complete` takes API-level options,
	 * where `reasoning` exists for a couple of providers only.
	 */
	runtime?: {
		completeSimple?(
			model: unknown,
			context: ReflectionContext,
			options: { reasoning?: ThinkingLevel },
		): Promise<ReflectionReply>;
	};
};

export type ReflectResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Model the reflection request runs on: the configured `{ providerId, modelId }`
 * when it is complete and the registry has it, else the session model. A
 * level-only config therefore just runs the session model at that level.
 */
export function resolveReflectModel(
	registry: unknown,
	sessionModel: unknown,
	configured: ReflectModelConfig | undefined,
): unknown {
	const { providerId, modelId } = configured ?? {};
	if (!providerId || !modelId) return sessionModel;
	const reg = registry as { find?: (provider: string, id: string) => unknown } | undefined;
	if (typeof reg?.find !== "function") return sessionModel;
	return reg.find(providerId, modelId) ?? sessionModel;
}

/**
 * Why a reply carried no text: providers report rate limits and API errors as
 * an empty content array plus stopReason/errorMessage, not as a throw.
 */
function emptyReplyReason(msg: { stopReason?: string; errorMessage?: string }): string {
	const detail = msg.errorMessage?.trim();
	if (detail) return detail;
	if (msg.stopReason && msg.stopReason !== "stop") {
		return `no text content (stopReason: ${msg.stopReason})`;
	}
	return "empty model response";
}

/** Whether the model advertises reasoning support; pi gates levels on this too. */
function supportsReasoning(model: unknown): boolean {
	return (model as { reasoning?: unknown } | undefined)?.reasoning === true;
}

/**
 * Run the reflection request, carrying the thinking level when there is one to
 * send. Prefer the facade's runtime (`completeSimple` — the path pi's own
 * summarization uses) because only that one maps a pi level onto the provider's
 * own option; `complete` takes API-level options and gets the level as a
 * fallback for the providers that declare `reasoning` themselves.
 */
function sendReflection(
	registry: ModelRegistryLike,
	model: unknown,
	context: ReflectionContext,
	thinkingLevel: ThinkingLevel | undefined,
): Promise<ReflectionReply> {
	const reasoning =
		thinkingLevel && thinkingLevel !== "off" && supportsReasoning(model)
			? thinkingLevel
			: undefined;
	if (!reasoning) return registry.complete(model, context);
	return (
		registry.runtime?.completeSimple?.(model, context, { reasoning }) ??
		registry.complete(model, context, { reasoning })
	);
}

/**
 * One clean, session-independent LLM request that reflects on failed edit
 * calls. The host's ModelRegistry performs model + auth resolution; nothing
 * of the current conversation (history, tools, prompts) is included.
 */
export async function reflectOnErrors(
	registry: ModelRegistryLike,
	model: unknown,
	failures: FailedEdit[],
	thinkingLevel?: ThinkingLevel,
): Promise<ReflectResult> {
	try {
		const digest = failures.map(compactFailure).join("\n");
		const msg = await sendReflection(
			registry,
			model,
			{ systemPrompt: REFLECTION_SYSTEM, messages: [{ role: "user", content: digest }] },
			thinkingLevel,
		);
		const text = (msg.content ?? [])
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n")
			.trim();
		if (text.length === 0) return { ok: false, error: emptyReplyReason(msg) };
		return { ok: true, text };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

// ---------- passive reflection (turn_end) ----------

/** Prepended to every reflection verdict sent back to the session agent. */
const REFLECTION_HEADER =
	"[ast-edit.reflection] Edit-tool failure reflection — follow these rules to avoid repeating them:\n\n";

/** Custom message type for verdicts: shown in the transcript, never a user turn. */
export const REFLECTION_MESSAGE_TYPE = "ast-edit.reflection";

/** Carried by the verdict message: the newest failure it covered. */
interface ReflectionMessageDetails {
	coveredTs: string;
}

/** Build the transcript message carrying one verdict and its coverage marker. */
function reflectionMessage(content: string, coveredTs: string) {
	const details: ReflectionMessageDetails = { coveredTs };
	return { customType: REFLECTION_MESSAGE_TYPE, content, display: true, details };
}

type SessionReader = SessionManagerLike & { getBranch?: () => unknown };

/**
 * How far this branch has already been reflected on: the marker stored on the
 * newest verdict message. Derived from session entries (no extra state), so a
 * restart or a resumed session does not reflect on the same failures twice.
 */
function coveredTs(ctx: { sessionManager?: SessionReader }): string | undefined {
	const entries = ctx.sessionManager?.getBranch?.();
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as EntryLike | undefined;
		if (entry?.type !== "custom_message" || entry.customType !== REFLECTION_MESSAGE_TYPE) continue;
		const ts = (entry.details as ReflectionMessageDetails | undefined)?.coveredTs;
		return typeof ts === "string" ? ts : undefined;
	}
	return undefined;
}

let reflectionInFlight = false;
/** Last failure notice shown, so a permanently broken model is reported once. */
let lastFailureNotice: string | undefined;
/**
 * Newest failure ts already covered by a verdict this process has *queued*.
 * `deliverAs: "nextTurn"` keeps the verdict off the branch until the next user
 * prompt, so `coveredTs()` cannot see it: without this, every further
 * `turn_end` of the same run finds those failures "uncovered" and reflects the
 * same batch again.
 */
let reflectedTs: string | undefined;

/** Later of two failure timestamps (`undefined`-tolerant; pi's format sorts as text). */
function laterTs(a: string | undefined, b: string | undefined): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return a > b ? a : b;
}

/** Clear the module-level reflection state (tests; also fine after a session switch). */
export function resetReflectionState(): void {
	reflectionInFlight = false;
	lastFailureNotice = undefined;
	reflectedTs = undefined;
}

/**
 * Passive reflection entrypoint, wired to `turn_end`. Looks for failed `edit`
 * calls on this branch that the last verdict did not cover and runs one clean
 * reflection request; the verdict is queued as a custom message for the next
 * turn so the agent can avoid repeating the mistakes. Never throws. Config is
 * re-read per call.
 */
export async function maybeReflect(
	pi: ExtensionAPI,
	ctx: {
		model?: unknown;
		modelRegistry?: unknown;
		/** Effective thinking level of the session model; the request default. */
		thinkingLevel?: ThinkingLevel;
		ui?: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		sessionManager?: SessionReader;
	},
): Promise<void> {
	const cfg = loadTraceConfig();
	if (!cfg.autoReflect) return;
	// Snapshot ctx fields before awaiting: the ctx goes stale after session
	// replacement or reload, and the request can outlive it.
	const registry = ctx.modelRegistry as ModelRegistryLike | undefined;
	const model = resolveReflectModel(registry, ctx.model, cfg.reflectModel);
	// The session's own configuration is the default; only what `reflectModel`
	// specifies overrides it.
	const thinkingLevel = cfg.reflectModel?.thinkingLevel ?? ctx.thinkingLevel;
	const ui = ctx.ui;
	if (!model || !registry) return; // no model to reflect with
	const since = laterTs(coveredTs(ctx), reflectedTs);
	const fresh = failedEdits(ctx.sessionManager?.getBranch?.()).filter(
		(failure) => since === undefined || failure.ts > since,
	);
	if (fresh.length < cfg.reflectAfterErrors || reflectionInFlight) return;
	reflectionInFlight = true;
	try {
		// Keep the request bounded: only the newest failures go in.
		const sample = fresh.slice(-MAX_FAILURES_PER_REFLECTION);
		const result = await reflectOnErrors(registry, model, sample, thinkingLevel);
		if (result.ok) {
			lastFailureNotice = undefined;
			// The verdict carries the marker; deliverAs nextTurn queues it as context
			// for the next user prompt instead of starting a turn (sendUserMessage
			// throws while the agent is busy). The same marker is kept locally, so the
			// rest of this run does not reflect the same failures again.
			const covered = fresh[fresh.length - 1].ts;
			pi.sendMessage(reflectionMessage(`${REFLECTION_HEADER}${result.text}`, covered), {
				deliverAs: "nextTurn",
			});
			reflectedTs = covered;
		} else if (ui && result.error !== lastFailureNotice) {
			// No marker is written on failure: the same failures are retried on the
			// next turn (the model may be temporarily rate-limited), and only the
			// first occurrence of a given reason is reported.
			lastFailureNotice = result.error;
			ui.notify(`ast-edit.reflection failed: ${result.error}`, "warning");
		}
	} finally {
		reflectionInFlight = false;
	}
}

/** Wire the passive turn-end reflection. */
export function initReflection(pi: ExtensionAPI): void {
	pi.on("turn_end", (_event, ctx) => maybeReflect(pi, ctx));
}
