import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Edit-tool telemetry, stored as per-session custom entries (pi.appendEntry).
 * Config lives in the `piAstEdit` key of pi's global settings file
 * (`~/.pi/agent/settings.json`); pi ignores and preserves unknown settings
 * keys, so this key round-trips safely.
 *
 * ```jsonc
 * {
 *   "piAstEdit": {
 *     "traceEnabled": true,   // default false; records every edit call in the session
 *     "insightsLines": 300    // entries analyzed per /ast-edit-insights run
 *   }
 * }
 * ```
 */
const CONFIG_KEY = "piAstEdit";
const TRACE_CUSTOM_TYPE = "piAstEditTrace";

export interface TraceConfig {
	traceEnabled: boolean;
	insightsLines: number;
}

export function loadTraceConfig(): TraceConfig {
	const cfg: TraceConfig = { traceEnabled: false, insightsLines: 300 };
	try {
		const settings = JSON.parse(readSettingsFile()) as Record<string, unknown> | undefined;
		const ext = settings?.[CONFIG_KEY];
		if (ext && typeof ext === "object") {
			const e = ext as Record<string, unknown>;
			if (typeof e.traceEnabled === "boolean") cfg.traceEnabled = e.traceEnabled;
			if (typeof e.insightsLines === "number" && e.insightsLines > 0) {
				cfg.insightsLines = Math.floor(e.insightsLines);
			}
		}
	} catch {
		// no settings file or unparsable JSON: fall back to defaults (trace off)
	}
	return cfg;
}

function readSettingsFile(): string {
	return readFileSync(join(getAgentDir(), "settings.json"), "utf8");
}

/** One recorded edit-tool call. Compact by design; never full file contents. */
export interface EditTraceRecord {
	ts: number;
	toolCallId: string;
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

let piRef: ExtensionAPI | null = null;

/**
 * Record one edit-tool call as a session custom entry. Never throws — a
 * logging failure must not break an edit.
 */
export function recordEditTrace(record: EditTraceRecord): void {
	if (!piRef) return;
	if (!traceConfigCache.traceEnabled) return;
	try {
		piRef.appendEntry(TRACE_CUSTOM_TYPE, record);
	} catch {
		// ignore: telemetry must never break the edit
	}
}

// Read once at extension load; /ast-edit-insights re-reads so config changes
// apply without restarting pi.
let traceConfigCache = loadTraceConfig();

const MAX_DIGEST_CHARS = 60_000;
const MAX_LINE_CHARS = 800;

type CustomEntryLike = {
	type: "custom";
	customType?: string;
	data?: unknown;
	timestamp?: string;
};

export function traceEntries(ctx: {
	sessionManager: { getEntries(): unknown[] };
}): Array<{ data: EditTraceRecord }> {
	const entries = ctx.sessionManager.getEntries() as CustomEntryLike[];
	return entries.filter(
		(e): e is CustomEntryLike & { data: EditTraceRecord } =>
			e.type === "custom" && e.customType === TRACE_CUSTOM_TYPE && isTraceRecord(e.data),
	);
}

export function isTraceRecord(data: unknown): data is EditTraceRecord {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as EditTraceRecord).ts === "number" &&
		typeof (data as EditTraceRecord).toolCallId === "string"
	);
}

export function compactRecord(rec: EditTraceRecord): string {
	const out = [
		new Date(rec.ts).toISOString().replace("T", " ").replace("Z", ""),
		rec.result === "ok" ? "OK" : rec.result === "aborted" ? "ABORTED" : "ERROR",
		rec.binary === "builtin-fallback" ? "fallback" : "ast-grep",
		rec.path,
		`applied=${rec.applied}`,
		`preErrors=${rec.preErrors}`,
		`postErrors=${rec.postErrors}`,
		`${rec.ms}ms`,
	];
	for (const e of rec.edits) {
		out.push(`${e.mode}${e.text ? `:\`${e.text}\`` : ""}`);
	}
	if (rec.error) out.push(`error: ${rec.error}`);
	const line = out.join("  ");
	// Cap at MAX_LINE_CHARS including the ellipsis.
	return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

export function buildDigest(records: EditTraceRecord[]): string {
	const out: string[] = [];
	let budget = MAX_DIGEST_CHARS;
	for (const rec of records) {
		const line = compactRecord(rec);
		if (out.length > 0 && budget - line.length <= 0) break;
		out.push(line);
		budget -= line.length;
	}
	return out.join("\n");
}

const ANALYSIS_PROMPT = (n: number): string =>
	[
		"Analysis task for the pi-ast-edit extension (the ast-grep powered edit tool).",
		"",
		`Source: the last ${n} recorded edit-tool calls of this session, most recent first.`,
		"Each line: timestamp, outcome, backend, path, per-edit mode with the pattern/text",
		"at stake, match/error counts, and the error message when the call failed.",
		"",
		"Task:",
		"1. Cluster the edit-tool failures and near-misses (e.g. ambiguous patterns, invalid",
		"   replacements, rolled-back edits, wrong-mode usage). Give counts per cluster.",
		"2. For each cluster: root cause (agent behavior vs tool limitation) and a concrete",
		"   improvement — exact wording for the tool description or promptGuidelines in",
		"   tools/edit-tool.ts, an ast-grep usage tip for the agent, a schema/description",
		"   change, or a bug location in src/edit.rs.",
		"3. Point out success patterns worth reinforcing in the guidelines.",
		"4. End with a one-paragraph summary naming the single most common failure to fix first.",
		"If nothing fails, say so in one sentence and skip the rest.",
		"",
		"Records:",
	].join("\n");

/**
 * `/ast-edit-insights [N|all]` — read the last N recorded edit-tool calls of
 * this session (default from `piAstEdit.insightsLines`) and hand them to the
 * session model as a user message, so the analysis lands in the transcript
 * and can be acted on. Active only; no passive triggering.
 */
export function registerInsightsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("ast-edit-insights", {
		description:
			"Analyze recorded edit-tool traces of this session with the session model; optional N (entries) or `all` argument",
		handler: async (args, ctx) => {
			traceConfigCache = loadTraceConfig();
			const arg = args.trim();
			const limit =
				arg === "all"
					? Number.MAX_SAFE_INTEGER
					: /^\d+$/.test(arg)
						? Number(arg)
						: traceConfigCache.insightsLines;
			const records = traceEntries(ctx)
				.map((e) => e.data)
				.slice(-limit)
				.reverse(); // most recent first
			if (records.length === 0) {
				ctx.ui.notify(
					`ast-edit-insights: no recorded edit calls in this session. Enable tracing via the piAstEdit key in ${join(getAgentDir(), "settings.json")} (traceEnabled: true) — records start with the next edit.`,
					"info",
				);
				return;
			}
			const digest = buildDigest(records);
			pi.sendUserMessage(`${ANALYSIS_PROMPT(records.length)}\n${digest}`);
		},
	});
}

/** Wire telemetry: remember pi for recordEditTrace and register the command. */
export function initInsights(pi: ExtensionAPI): void {
	piRef = pi;
	traceConfigCache = loadTraceConfig();
	registerInsightsCommand(pi);
}
