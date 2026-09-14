import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	compactFailure,
	defaultTracePath,
	type EditTraceRecord,
	type FailedEdit,
	failedEdits,
	loadTraceConfig,
	type ModelRegistryLike,
	maybeReflect,
	REFLECTION_MESSAGE_TYPE,
	recordEditTrace,
	reflectOnErrors,
	resetReflectionState,
	resolveReflectModel,
	type ThinkingLevel,
} from "../../tools/reflect.ts";

/**
 * Telemetry + reflection unit tests (node:test, zero deps). Config tests point
 * PI_CODING_AGENT_DIR at a temp dir; reflection tests feed a fake session
 * branch (assistant tool call + failed tool result).
 */

const dirsToClean: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piastedit-test-"));
	dirsToClean.push(dir);
	return dir;
}

function withAgentDir(settings: unknown): string {
	const dir = tempDir();
	process.env.PI_CODING_AGENT_DIR = dir;
	if (settings !== undefined) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}
	return dir;
}

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of dirsToClean) rmSync(dir, { recursive: true, force: true });
	dirsToClean.length = 0;
});

// `maybeReflect` keeps the queued-verdict marker in module state; a fresh
// process per test keeps the cases independent.
beforeEach(() => resetReflectionState());

function record(overrides: Partial<EditTraceRecord> = {}): EditTraceRecord {
	return {
		ts: 1_700_000_000_000,
		toolCallId: "call_1",
		sessionId: "s1",
		binary: "ast-grep",
		edits: [{ mode: "pattern", text: "foo($A)" }],
		path: "src/x.js",
		result: "ok",
		applied: 1,
		preErrors: 0,
		postErrors: 0,
		ms: 12,
		...overrides,
	};
}

// --- branch fixtures --------------------------------------------------------

/** Assistant message carrying one `edit` tool call. */
function editCall(id: string, path: string, edits: unknown) {
	return {
		type: "message",
		id: `a_${id}`,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "edit", arguments: { path, edits } }],
		},
	};
}

function toolResult(
	id: string,
	toolName: string,
	isError: boolean,
	text: string,
	ts = "2026-01-01T00:00:01.000Z",
) {
	return {
		type: "message",
		id: `r_${id}`,
		timestamp: ts,
		message: {
			role: "toolResult",
			toolName,
			toolCallId: id,
			isError,
			content: [{ type: "text", text }],
		},
	};
}

/** A failed edit call: assistant tool call + error tool result. */
function failedEdit(
	id: string,
	ts = "2026-01-01T00:00:01.000Z",
	path = "src/x.js",
	error = "edits[0]: pattern `foo($A)` matched 2 nodes",
) {
	return [
		editCall(id, path, [{ pattern: "foo($A)", replace: "bar($A)" }]),
		toolResult(id, "edit", true, error, ts),
	];
}

function verdict(coveredTs: string) {
	return {
		type: "custom_message",
		customType: REFLECTION_MESSAGE_TYPE,
		details: { coveredTs },
	};
}

// --- A. loadTraceConfig -----------------------------------------------------

test("A1: missing settings file -> defaults (log off, reflection on)", () => {
	withAgentDir(undefined);
	assert.deepEqual(loadTraceConfig(), {
		traceEnabled: false,
		autoReflect: true,
		reflectAfterErrors: 3,
	});
});

test("A2: invalid JSON -> defaults", () => {
	withAgentDir("{ not json");
	assert.deepEqual(loadTraceConfig(), {
		traceEnabled: false,
		autoReflect: true,
		reflectAfterErrors: 3,
	});
});

test("A3: unrelated settings -> defaults", () => {
	withAgentDir({ defaultModel: "x" });
	assert.deepEqual(loadTraceConfig(), {
		traceEnabled: false,
		autoReflect: true,
		reflectAfterErrors: 3,
	});
});

test("A4: ast-edit not an object -> defaults", () => {
	for (const bad of ["string", null, [1, 2]]) {
		withAgentDir({ "ast-edit": bad });
		assert.deepEqual(
			loadTraceConfig(),
			{ traceEnabled: false, autoReflect: true, reflectAfterErrors: 3 },
			`ast-edit=${JSON.stringify(bad)}`,
		);
	}
});

test("A5: traceEnabled / autoReflect booleans honored", () => {
	withAgentDir({ "ast-edit": { traceEnabled: true, autoReflect: false } });
	const cfg = loadTraceConfig();
	assert.equal(cfg.traceEnabled, true);
	assert.equal(cfg.autoReflect, false);
});

test("A6: wrong types ignored -> trace off, reflection on", () => {
	withAgentDir({ "ast-edit": { traceEnabled: "true", autoReflect: 1 } });
	const cfg = loadTraceConfig();
	assert.equal(cfg.traceEnabled, false);
	assert.equal(cfg.autoReflect, true);
});

test("A7: reflectAfterErrors honored, invalid values fall back to 3", () => {
	withAgentDir({ "ast-edit": { reflectAfterErrors: 5 } });
	assert.equal(loadTraceConfig().reflectAfterErrors, 5);
	withAgentDir({ "ast-edit": { reflectAfterErrors: 2.7 } });
	assert.equal(loadTraceConfig().reflectAfterErrors, 2);
	for (const bad of [0, -5, "3"]) {
		withAgentDir({ "ast-edit": { reflectAfterErrors: bad } });
		assert.equal(
			loadTraceConfig().reflectAfterErrors,
			3,
			`reflectAfterErrors=${JSON.stringify(bad)}`,
		);
	}
});

test("A8: tracePath honored when string, ignored otherwise; default under agent dir", () => {
	withAgentDir({ "ast-edit": { tracePath: "/tmp/custom-trace.jsonl" } });
	assert.equal(loadTraceConfig().tracePath, "/tmp/custom-trace.jsonl");
	for (const bad of [42, true, ""]) {
		withAgentDir({ "ast-edit": { tracePath: bad } });
		assert.equal(loadTraceConfig().tracePath, undefined, `tracePath=${JSON.stringify(bad)}`);
	}
	const dir = withAgentDir({});
	assert.equal(defaultTracePath(), join(dir, "ast-edit.log.jsonl"));
});

test("A9: reflectModel is { providerId, modelId, thinkingLevel? }; bad shapes are ignored", () => {
	withAgentDir({
		"ast-edit": {
			reflectModel: {
				providerId: "openrouter",
				modelId: "nvidia/nemotron:free",
				thinkingLevel: "high",
			},
		},
	});
	assert.deepEqual(loadTraceConfig().reflectModel, {
		providerId: "openrouter",
		modelId: "nvidia/nemotron:free",
		thinkingLevel: "high",
	});
	// an unknown level is dropped, the model stays
	withAgentDir({
		"ast-edit": { reflectModel: { providerId: "openrouter", modelId: "x", thinkingLevel: "HIGH" } },
	});
	assert.deepEqual(loadTraceConfig().reflectModel, { providerId: "openrouter", modelId: "x" });
	// a level alone keeps the session model, so it is a valid config on its own
	withAgentDir({ "ast-edit": { reflectModel: { thinkingLevel: "medium" } } });
	assert.deepEqual(loadTraceConfig().reflectModel, { thinkingLevel: "medium" });
	const bad = [
		{ providerId: "openrouter" },
		{ modelId: "nvidia/nemotron:free" },
		{ providerId: "openrouter", thinkingLevel: "HIGH" },
		{ providerId: "", modelId: "x" },
		{ providerId: "openrouter", modelId: "" },
		{ providerId: 42, modelId: "x" },
		42,
		true,
	];
	for (const value of bad) {
		withAgentDir({ "ast-edit": { reflectModel: value } });
		assert.equal(
			loadTraceConfig().reflectModel,
			undefined,
			`reflectModel=${JSON.stringify(value)}`,
		);
	}
});

// --- B. developer log (opt-in) ----------------------------------------------

test("B1: trace off by default -> no file written", () => {
	const dir = withAgentDir({});
	assert.doesNotThrow(() => recordEditTrace(record()));
	assert.equal(existsSync(join(dir, "ast-edit.log.jsonl")), false);
});

test("B2: traceEnabled true -> one JSON line with all fields", () => {
	const dir = withAgentDir({ "ast-edit": { traceEnabled: true } });
	recordEditTrace(record());
	const lines = readTrace(join(dir, "ast-edit.log.jsonl"));
	assert.equal(lines.length, 1);
	assert.deepEqual(lines[0], record());
});

test("B3: records append as lines, order preserved", () => {
	const dir = withAgentDir({ "ast-edit": { traceEnabled: true } });
	recordEditTrace(record({ toolCallId: "a", path: "a.js" }));
	recordEditTrace(record({ toolCallId: "b", path: "b.js" }));
	const lines = readTrace(join(dir, "ast-edit.log.jsonl"));
	assert.deepEqual(
		lines.map((r) => r.path),
		["a.js", "b.js"],
	);
});

test("B4: custom tracePath honored", () => {
	const custom = join(tempDir(), "custom-name.jsonl");
	withAgentDir({ "ast-edit": { traceEnabled: true, tracePath: custom } });
	recordEditTrace(record());
	assert.equal(readTrace(custom).length, 1);
});

test("B5: unwritable tracePath swallowed (never throws)", () => {
	const dir = tempDir();
	const custom = join(dir, "blocker", "x.jsonl");
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ "ast-edit": { traceEnabled: true, tracePath: custom } }),
	);
	// `blocker` exists as a file, so mkdirSync(dirname) fails with ENOTDIR.
	writeFileSync(join(dir, "blocker"), "i am a file, not a dir");
	assert.doesNotThrow(() => recordEditTrace(record()));
});

function readTrace(path: string): EditTraceRecord[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as EditTraceRecord);
}

// --- C. failedEdits (branch scanning) --------------------------------------

test("C1: only failed edit results are collected", () => {
	const entries = [
		...failedEdit("c1"),
		toolResult("ok1", "edit", false, "Applied 1 edit(s) to src/x.js:"),
		toolResult("bash1", "bash", true, "command failed"), // other tool
		{
			type: "message",
			id: "r_partial",
			message: { role: "toolResult", toolName: "edit", isError: true },
		},
	];
	const failures = failedEdits(entries);
	assert.equal(failures.length, 1);
	assert.equal(failures[0].entryId, "r_c1");
	assert.equal(failures[0].ts, "2026-01-01T00:00:01.000Z");
	assert.equal(failures[0].path, "src/x.js");
	assert.match(failures[0].edits, /pattern:`foo\(\$A\)`/);
	assert.match(failures[0].error, /matched 2 nodes/);
});

test("C2: path/edits come from the matching call; unmatched calls are skipped", () => {
	const entries = [
		editCall("c2", "lib/y.ts", [{ oldText: "a", newText: "b" }, { pattern: "q($A)" }]),
		toolResult("c2", "edit", true, "boom"),
		toolResult("orphan", "edit", true, "no call for me"),
	];
	const failures = failedEdits(entries);
	assert.equal(failures.length, 1, "a call we cannot match is not provably ours");
	assert.equal(failures[0].path, "lib/y.ts");
	assert.equal(failures[0].edits, "exact:`a`  pattern:`q($A)`");
});

test("C5: another extension's `edit` failures are ignored", () => {
	const entries = [
		editCall("h1", "src/x.js", [{ op: "replace", pos: "1#AB", lines: ["x"] }]),
		toolResult("h1", "edit", true, "[E_STALE_ANCHOR] 1 stale anchor: 1#AB."),
	];
	assert.deepEqual(failedEdits(entries), []);
});

test("C6: mixed branch keeps ours (JSON-string edits too) and drops theirs", () => {
	const entries = [
		editCall("h2", "src/x.js", [{ op: "replace", pos: "2#CD", lines: ["y"] }]),
		toolResult("h2", "edit", true, '[E_BAD_REF] Invalid line reference "…".'),
		editCall("o1", "src/z.js", [{ oldText: "a", newText: "b" }]),
		toolResult("o1", "edit", true, "edits[0]: could not find the exact text in the file"),
		{
			type: "message",
			id: "a_o2",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "o2",
						name: "edit",
						arguments: { path: "src/s.js", edits: '[{"pattern":"p($A)","replace":"q($A)"}]' },
					},
				],
			},
		},
		toolResult("o2", "edit", true, "edits[0]: pattern `p($A)` matched nothing in the file"),
	];
	const failures = failedEdits(entries);
	assert.deepEqual(
		failures.map((failure) => failure.path),
		["src/z.js", "src/s.js"],
	);
	assert.ok(!failures.some((failure) => failure.error.includes("E_BAD_REF")));
});

test("C7: the legacy top-level oldText/newText shape is ours", () => {
	const entries = [
		{
			type: "message",
			id: "a_c7",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c7",
						name: "edit",
						arguments: { path: "src/l.js", oldText: "a", newText: "b" },
					},
				],
			},
		},
		toolResult("c7", "edit", true, "edits[0]: could not find the exact text"),
	];
	const failures = failedEdits(entries);
	assert.equal(failures.length, 1);
	assert.equal(failures[0].path, "src/l.js");
	assert.equal(failures[0].edits, "");
});

test("C8: a single edit object (direct or inside a JSON string) is ours", () => {
	const entries = [
		editCall("s1", "src/s1.js", { oldText: "a", newText: "b" }),
		toolResult("s1", "edit", true, "edits[0]: could not find the exact text"),
		editCall("s2", "src/s2.js", '{"pattern":"p($A)","replace":"q($A)"}'),
		toolResult("s2", "edit", true, "edits[0]: pattern `p($A)` matched nothing"),
	];
	assert.deepEqual(
		failedEdits(entries).map((failure) => failure.path),
		["src/s1.js", "src/s2.js"],
	);
});

test("C3: non-array / empty input -> no failures", () => {
	assert.deepEqual(failedEdits(undefined), []);
	assert.deepEqual(failedEdits({}), []);
	assert.deepEqual(failedEdits([]), []);
});

test("C4: multi-line error text is flattened into one line", () => {
	const entries = [
		...failedEdit("c4", undefined, "src/x.js", "line one\nline two\n\n  line three"),
	];
	assert.equal(failedEdits(entries)[0].error, "line one line two line three");
});

// --- D. compactFailure / digest ---------------------------------------------

test("D1: failure rendered as one line with path, edits and error", () => {
	const failure: FailedEdit = {
		entryId: "e1",
		ts: "2026-01-01T00:00:01.000Z",
		path: "src/x.js",
		edits: "pattern:`foo($A)`",
		error: "matched 2 nodes",
	};
	const line = compactFailure(failure);
	assert.match(line, /^ERROR\s+src\/x\.js\s+pattern:`foo\(\$A\)`\s+— matched 2 nodes$/);
});

test("D2: line capped at 800 chars", () => {
	const long = compactFailure({
		entryId: "e1",
		ts: "2026-01-01T00:00:01.000Z",
		path: "src/x.js",
		edits: "",
		error: "e".repeat(900),
	});
	assert.equal(long.length, 800);
	assert.ok(long.endsWith("…"));
});

// --- E. reflectOnErrors -----------------------------------------------------

function fakeRegistry(reply = "rules text") {
	const calls: Array<{
		systemPrompt?: string;
		messages: Array<{ role: string; content: string }>;
	}> = [];
	const registry = {
		complete: async (
			_model: unknown,
			context: { systemPrompt?: string; messages: Array<{ role: string; content: string }> },
		) => {
			calls.push(context);
			return { content: [{ type: "text", text: reply }] };
		},
	} as unknown as ModelRegistryLike;
	return { registry, calls };
}

function failure(overrides: Partial<FailedEdit> = {}): FailedEdit {
	return {
		entryId: "e1",
		ts: "2026-01-01T00:00:01.000Z",
		path: "src/a.js",
		edits: "pattern:`foo($A)`",
		error: "matched 2 nodes",
		...overrides,
	};
}

test("E1: builds a clean, session-independent request", async () => {
	const { registry, calls } = fakeRegistry("avoid ambiguous patterns");
	const result = await reflectOnErrors(registry, { id: "m" }, [
		failure(),
		failure({ entryId: "e2", path: "src/b.js", error: "could not parse" }),
	]);
	assert.deepEqual(result, { ok: true, text: "avoid ambiguous patterns" });
	assert.equal(calls.length, 1);
	assert.match(calls[0].systemPrompt ?? "", /FAILED edit-tool calls/);
	assert.doesNotMatch(calls[0].systemPrompt ?? "", /history|conversation|tools/i);
	const digest = calls[0].messages[0].content;
	assert.match(digest, /src\/a\.js/);
	assert.match(digest, /src\/b\.js/);
	assert.match(digest, /matched 2 nodes/);
});

test("E2: degrades on a throwing registry and an empty reply", async () => {
	const throwing = {
		complete: async () => {
			throw new Error("auth failed");
		},
	} as unknown as ModelRegistryLike;
	assert.deepEqual(await reflectOnErrors(throwing, {}, [failure()]), {
		ok: false,
		error: "auth failed",
	});
	assert.deepEqual(await reflectOnErrors(fakeRegistry("   ").registry, {}, [failure()]), {
		ok: false,
		error: "empty model response",
	});
});

test("E3: provider error surfaces stopReason / errorMessage, not 'empty response'", async () => {
	const rateLimited = {
		complete: async () => ({
			content: [],
			stopReason: "error",
			errorMessage: "429: Rate limit exceeded: free-models-per-day",
		}),
	} as unknown as ModelRegistryLike;
	assert.deepEqual(await reflectOnErrors(rateLimited, {}, [failure()]), {
		ok: false,
		error: "429: Rate limit exceeded: free-models-per-day",
	});

	const abortedNoReason = {
		complete: async () => ({ content: [], stopReason: "aborted" }),
	} as unknown as ModelRegistryLike;
	assert.deepEqual(await reflectOnErrors(abortedNoReason, {}, [failure()]), {
		ok: false,
		error: "no text content (stopReason: aborted)",
	});
});

/** Registry that records which request path ran and with which reasoning level. */
function levelRegistry(withRuntime: boolean) {
	const seen: Array<{ path: string; reasoning?: string }> = [];
	const reply = { content: [{ type: "text", text: "rules" }] };
	const runtime = {
		completeSimple: async (_m: unknown, _c: unknown, options: { reasoning?: string }) => {
			seen.push({
				path: "completeSimple",
				...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
			});
			return reply;
		},
	};
	const registry = {
		...(withRuntime ? { runtime } : {}),
		complete: async (_m: unknown, _c: unknown, options?: { reasoning?: string }) => {
			seen.push({
				path: "complete",
				...(options?.reasoning ? { reasoning: options.reasoning } : {}),
			});
			return reply;
		},
	} as unknown as ModelRegistryLike;
	return { registry, seen };
}

test("E4: the thinking level rides the simple request path, with a complete() fallback", async () => {
	const model = { id: "m", reasoning: true };
	const simple = levelRegistry(true);
	assert.deepEqual(await reflectOnErrors(simple.registry, model, [failure()], "high"), {
		ok: true,
		text: "rules",
	});
	assert.deepEqual(simple.seen, [{ path: "completeSimple", reasoning: "high" }]);

	// no runtime on the facade (or an older host): the level still goes out
	const plain = levelRegistry(false);
	await reflectOnErrors(plain.registry, model, [failure()], "high");
	assert.deepEqual(plain.seen, [{ path: "complete", reasoning: "high" }]);
});

test("E5: no level is sent for `off`, a non-reasoning model, or no configured level", async () => {
	for (const [model, level] of [
		[{ id: "m", reasoning: true }, "off"],
		[{ id: "m", reasoning: false }, "high"],
		[{ id: "m", reasoning: true }, undefined],
	] as Array<[unknown, "off" | "high" | undefined]>) {
		const { registry, seen } = levelRegistry(true);
		await reflectOnErrors(registry, model, [failure()], level);
		assert.deepEqual(seen, [{ path: "complete" }], `model=${JSON.stringify(model)} level=${level}`);
	}
});

// --- F. maybeReflect --------------------------------------------------------

function autoPi() {
	const sent: Array<{ customType: string; content: string; display?: boolean; details?: unknown }> =
		[];
	const notices: string[] = [];
	return {
		sent,
		notices,
		pi: { sendMessage: (msg: (typeof sent)[number]) => sent.push(msg) } as unknown as ExtensionAPI,
	};
}

function autoCtx(
	registry: ModelRegistryLike,
	branch: unknown[] = [],
	notices?: string[],
): Parameters<typeof maybeReflect>[1] {
	return {
		model: { id: "session-model" },
		modelRegistry: registry,
		ui: notices ? { notify: (m: string) => notices.push(m) } : undefined,
		sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
	};
}

test("F1: below the threshold nothing happens; crossing it reflects once", async () => {
	withAgentDir({}); // no settings: developer log off, reflection on, threshold 3
	const { registry, calls } = fakeRegistry("use matchIndex");
	const { pi, sent } = autoPi();
	const one = failedEdit("f1", "2026-01-01T00:00:01.000Z", "src/a.js");

	// one failure is below the default threshold of 3
	await maybeReflect(pi, autoCtx(registry, one));
	assert.equal(calls.length, 0);
	assert.equal(sent.length, 0);

	// failures accumulate across turns until the threshold is reached
	const two = failedEdit("f2", "2026-01-01T00:00:02.000Z", "src/b.js", "no match");
	await maybeReflect(pi, autoCtx(registry, [...one, ...two]));
	assert.equal(calls.length, 0, "2 < 3");

	const three = failedEdit("f3", "2026-01-01T00:00:03.000Z", "src/c.js", "invalid replacement");
	const branch = [...one, ...two, ...three];
	await maybeReflect(pi, autoCtx(registry, branch));
	assert.equal(calls.length, 1);
	const digest = calls[0].messages[0].content;
	assert.match(digest, /src\/a\.js/);
	assert.match(digest, /src\/b\.js/);
	assert.match(digest, /src\/c\.js/);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].customType, REFLECTION_MESSAGE_TYPE);
	assert.equal(sent[0].display, true);
	assert.deepEqual(sent[0].details, { coveredTs: "2026-01-01T00:00:03.000Z" });
	assert.ok(sent[0].content.includes("use matchIndex"));
	assert.ok(sent[0].content.includes("avoid repeating them"));

	// the verdict is on the branch -> the same failures are not reflected again
	await maybeReflect(pi, autoCtx(registry, [...branch, verdict("2026-01-01T00:00:03.000Z")]));
	assert.equal(calls.length, 1);
	assert.equal(sent.length, 1);

	// three NEW failures cross the threshold again, and only they are included
	const next = [
		failedEdit("f4", "2026-01-01T00:00:04.000Z", "src/d.js", "e4"),
		failedEdit("f5", "2026-01-01T00:00:05.000Z", "src/e.js", "e5"),
		failedEdit("f6", "2026-01-01T00:00:06.000Z", "src/f.js", "e6"),
	];
	await maybeReflect(
		pi,
		autoCtx(registry, [...branch, verdict("2026-01-01T00:00:03.000Z"), ...next.flat()]),
	);
	assert.equal(calls.length, 2);
	assert.match(calls[1].messages[0].content, /src\/f\.js/);
	assert.doesNotMatch(calls[1].messages[0].content, /src\/a\.js/);
	assert.deepEqual(sent[1].details, { coveredTs: "2026-01-01T00:00:06.000Z" });
});

test("F2: no failed edits -> no request, no message", async () => {
	withAgentDir({});
	const { registry, calls } = fakeRegistry();
	const { pi, sent, notices } = autoPi();
	await maybeReflect(
		pi,
		autoCtx(registry, [toolResult("ok", "edit", false, "Applied 1 edit(s)")], notices),
	);
	assert.equal(calls.length, 0);
	assert.equal(sent.length, 0);
	assert.equal(notices.length, 0);
});

test("F3: autoReflect false disables reflection", async () => {
	withAgentDir({ "ast-edit": { autoReflect: false } });
	const { registry, calls } = fakeRegistry();
	const { pi, sent } = autoPi();
	await maybeReflect(pi, autoCtx(registry, failedEdit("f3")));
	assert.equal(calls.length, 0);
	assert.equal(sent.length, 0);
});

test("F4: failure notifies once, writes no marker, retries next turn", async () => {
	withAgentDir({});
	let attempts = 0;
	const failing = {
		complete: async () => {
			attempts++;
			throw new Error("429 rate limited");
		},
	} as unknown as ModelRegistryLike;
	const { pi, sent, notices } = autoPi();
	const branch = [
		...failedEdit("f4a", "2026-01-01T00:00:01.000Z"),
		...failedEdit("f4b", "2026-01-01T00:00:02.000Z"),
		...failedEdit("f4c", "2026-01-01T00:00:03.000Z"),
	];

	await maybeReflect(pi, autoCtx(failing, branch, notices));
	assert.equal(sent.length, 0, "no verdict on failure");
	assert.deepEqual(notices, ["ast-edit.reflection failed: 429 rate limited"]);

	// no marker was written -> same failures retried, but not re-reported
	await maybeReflect(pi, autoCtx(failing, branch, notices));
	assert.equal(attempts, 2);
	assert.equal(notices.length, 1, "identical failure reported once");
});

test("F5: configured model and thinking level are used when they resolve", async () => {
	withAgentDir({
		"ast-edit": {
			reflectModel: { providerId: "openrouter", modelId: "nvidia/x:free", thinkingLevel: "high" },
		},
	});
	const { registry, calls } = fakeRegistry("configured rules");
	const used: unknown[] = [];
	const levels: Array<string | undefined> = [];
	const delegate = (model: unknown, context: unknown) =>
		(registry as unknown as { complete: (m: unknown, c: unknown) => Promise<unknown> }).complete(
			model,
			context,
		);
	const tracking = {
		find: (provider: string, id: string) => ({ provider, id, tag: "configured", reasoning: true }),
		// the level is only portable on the simple path, so that is the one used
		runtime: {
			completeSimple: async (model: unknown, context: unknown, options: { reasoning?: string }) => {
				used.push(model);
				levels.push(options.reasoning);
				return delegate(model, context);
			},
		},
		complete: async (model: unknown, context: unknown) => {
			used.push(model);
			levels.push(undefined);
			return delegate(model, context);
		},
	} as unknown as ModelRegistryLike;
	const { pi } = autoPi();
	await maybeReflect(
		pi,
		autoCtx(tracking, [
			...failedEdit("f5a", "2026-01-01T00:00:01.000Z"),
			...failedEdit("f5b", "2026-01-01T00:00:02.000Z"),
			...failedEdit("f5c", "2026-01-01T00:00:03.000Z"),
		]),
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(used, [
		{ provider: "openrouter", id: "nvidia/x:free", tag: "configured", reasoning: true },
	]);
	assert.deepEqual(levels, ["high"]);
});

test("F6: a second turn_end of the same run does not reflect again", async () => {
	withAgentDir({});
	const { registry, calls } = fakeRegistry("use matchIndex");
	const { pi, sent } = autoPi();
	const branch = [
		...failedEdit("f6a", "2026-01-01T00:00:01.000Z"),
		...failedEdit("f6b", "2026-01-01T00:00:02.000Z"),
		...failedEdit("f6c", "2026-01-01T00:00:03.000Z"),
	];

	// deliverAs: "nextTurn" keeps the verdict off the branch, so this is the
	// state the next turn_end of the same run sees.
	await maybeReflect(pi, autoCtx(registry, branch));
	assert.equal(calls.length, 1);
	assert.equal(sent.length, 1);

	await maybeReflect(pi, autoCtx(registry, branch));
	assert.equal(calls.length, 1, "same batch reflected once");
	assert.equal(sent.length, 1);
});

test("F7: the queued verdict landing on the branch changes nothing", async () => {
	withAgentDir({});
	const { registry, calls } = fakeRegistry();
	const { pi, sent } = autoPi();
	const branch = [
		...failedEdit("f7a", "2026-01-01T00:00:01.000Z"),
		...failedEdit("f7b", "2026-01-01T00:00:02.000Z"),
		...failedEdit("f7c", "2026-01-01T00:00:03.000Z"),
	];

	await maybeReflect(pi, autoCtx(registry, branch));
	await maybeReflect(pi, autoCtx(registry, [...branch, verdict("2026-01-01T00:00:03.000Z")]));
	assert.equal(calls.length, 1);
	assert.equal(sent.length, 1);
});

test("F8: new failures after a queued verdict reflect again, alone", async () => {
	withAgentDir({});
	const { registry, calls } = fakeRegistry("rules");
	const { pi, sent } = autoPi();
	const first = [
		...failedEdit("f8a", "2026-01-01T00:00:01.000Z", "src/a.js"),
		...failedEdit("f8b", "2026-01-01T00:00:02.000Z", "src/b.js"),
		...failedEdit("f8c", "2026-01-01T00:00:03.000Z", "src/c.js"),
	];
	await maybeReflect(pi, autoCtx(registry, first));
	assert.equal(calls.length, 1);

	const next = [
		...failedEdit("f8d", "2026-01-01T00:00:04.000Z", "src/d.js"),
		...failedEdit("f8e", "2026-01-01T00:00:05.000Z", "src/e.js"),
		...failedEdit("f8f", "2026-01-01T00:00:06.000Z", "src/f.js"),
	];
	await maybeReflect(pi, autoCtx(registry, [...first, ...next]));
	assert.equal(calls.length, 2);
	assert.match(calls[1].messages[0].content, /src\/d\.js/);
	assert.doesNotMatch(calls[1].messages[0].content, /src\/a\.js/);
	assert.deepEqual(sent[1].details, { coveredTs: "2026-01-01T00:00:06.000Z" });
});

test("F9: a failed reflection does not advance the queued marker", async () => {
	withAgentDir({});
	const failing = {
		complete: async () => {
			throw new Error("429 rate limited");
		},
	} as unknown as ModelRegistryLike;
	const { pi, sent } = autoPi();
	const branch = [
		...failedEdit("f9a", "2026-01-01T00:00:01.000Z"),
		...failedEdit("f9b", "2026-01-01T00:00:02.000Z"),
		...failedEdit("f9c", "2026-01-01T00:00:03.000Z"),
	];

	await maybeReflect(pi, autoCtx(failing, branch));
	assert.equal(sent.length, 0, "no verdict on failure");

	// the batch is still pending: a working model reflects it once
	const { registry, calls } = fakeRegistry("retry rules");
	await maybeReflect(pi, autoCtx(registry, branch));
	assert.equal(calls.length, 1);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].details, { coveredTs: "2026-01-01T00:00:03.000Z" });
});

test("F10: reflection ignores another extension's edit failures", async () => {
	withAgentDir({}); // threshold 3
	const { registry, calls } = fakeRegistry("rules");
	const { pi, sent } = autoPi();
	const foreign = [
		editCall("h3a", "src/x.js", [{ op: "replace", pos: "3#EF", lines: ["z"] }]),
		toolResult("h3a", "edit", true, "[E_STALE_ANCHOR] 1 stale anchor: 3#EF."),
		editCall("h3b", "src/x.js", [{ lines: ["z"], op: "replace", pos: "4#GH" }]),
		toolResult("h3b", "edit", true, "[E_STALE_ANCHOR] 1 stale anchor: 4#GH."),
		editCall("h3c", "src/x.js", [{ lines: ["z"], op: "replace", pos: "5#IJ" }]),
		toolResult("h3c", "edit", true, "[E_STALE_ANCHOR] 1 stale anchor: 5#IJ."),
	];

	await maybeReflect(pi, autoCtx(registry, foreign));
	assert.equal(calls.length, 0, "foreign failures are not a batch");
	assert.equal(sent.length, 0);

	const ours = [
		...failedEdit("f10a", "2026-01-01T00:00:01.000Z", "src/a.js"),
		...failedEdit("f10b", "2026-01-01T00:00:02.000Z", "src/b.js"),
		...failedEdit("f10c", "2026-01-01T00:00:03.000Z", "src/c.js"),
	];
	await maybeReflect(pi, autoCtx(registry, [...foreign, ...ours]));
	assert.equal(calls.length, 1);
	assert.match(calls[0].messages[0].content, /src\/a\.js/);
	assert.doesNotMatch(calls[0].messages[0].content, /E_STALE_ANCHOR/);
});

test("F11: a pile-up is capped at the 50 newest failures", async () => {
	withAgentDir({});
	const { registry, calls } = fakeRegistry("rules");
	const { pi, sent } = autoPi();
	// 60 failures, one per minute: the newest 50 are f10..f59
	const branch = Array.from({ length: 60 }, (_, i) => {
		const stamp = `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`;
		return failedEdit(`p${i}`, stamp, `src/f${i}.js`);
	}).flat();

	await maybeReflect(pi, autoCtx(registry, branch));
	assert.equal(calls.length, 1);
	const digest = calls[0].messages[0].content;
	assert.equal(digest.split("\n").length, 50);
	assert.doesNotMatch(digest, /src\/f0\.js/); // oldest dropped
	assert.match(digest, /src\/f10\.js/);
	assert.match(digest, /src\/f59\.js/);
	assert.deepEqual(sent[0].details, { coveredTs: "2026-01-01T00:59:00.000Z" });
});

test("F12: a level-only config keeps the session model and still sends the level", async () => {
	withAgentDir({ "ast-edit": { reflectModel: { thinkingLevel: "medium" } } });
	const models: unknown[] = [];
	const levels: Array<string | undefined> = [];
	const registry = {
		find: () => {
			throw new Error("find must not run for a level-only config");
		},
		runtime: {
			completeSimple: async (m: unknown, _c: unknown, options: { reasoning?: string }) => {
				models.push(m);
				levels.push(options.reasoning);
				return { content: [{ type: "text", text: "think harder" }] };
			},
		},
	} as unknown as ModelRegistryLike;
	const { pi, sent } = autoPi();
	const session = { id: "session-model", reasoning: true };
	await maybeReflect(pi, {
		model: session,
		modelRegistry: registry,
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => [
				...failedEdit("f12a", "2026-01-01T00:00:01.000Z"),
				...failedEdit("f12b", "2026-01-01T00:00:02.000Z"),
				...failedEdit("f12c", "2026-01-01T00:00:03.000Z"),
			],
		},
	});
	assert.deepEqual(models, [session]);
	assert.deepEqual(levels, ["medium"]);
	assert.equal(sent.length, 1);
});

test("F13: the session's thinking level is the default, a configured one overrides it", async () => {
	const levels: Array<string | undefined> = [];
	const used: unknown[] = [];
	const registry = {
		runtime: {
			completeSimple: async (m: unknown, _c: unknown, options: { reasoning?: string }) => {
				used.push(m);
				levels.push(options.reasoning);
				return { content: [{ type: "text", text: "rules" }] };
			},
		},
		complete: async (m: unknown, _c: unknown, options?: { reasoning?: string }) => {
			used.push(m);
			levels.push(options?.reasoning);
			return { content: [{ type: "text", text: "rules" }] };
		},
	} as unknown as ModelRegistryLike;
	const session = { id: "session-model", reasoning: true };
	const ctx = (thinkingLevel: ThinkingLevel | undefined) => ({
		model: session,
		thinkingLevel,
		modelRegistry: registry,
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => [
				...failedEdit("f13a", "2026-01-01T00:00:01.000Z"),
				...failedEdit("f13b", "2026-01-01T00:00:02.000Z"),
				...failedEdit("f13c", "2026-01-01T00:00:03.000Z"),
			],
		},
	});
	const { pi } = autoPi();

	// nothing configured: the session's own level is used
	withAgentDir({});
	await maybeReflect(pi, ctx("high"));
	assert.deepEqual(levels, ["high"]);

	// a configured level wins over the session's
	resetReflectionState();
	withAgentDir({ "ast-edit": { reflectModel: { thinkingLevel: "low" } } });
	await maybeReflect(pi, ctx("high"));
	assert.deepEqual(levels, ["high", "low"]);

	// session "off" (or a non-reasoning model) sends nothing at all
	resetReflectionState();
	withAgentDir({});
	await maybeReflect(pi, ctx("off"));

	// switching the model does not change the default level
	resetReflectionState();
	withAgentDir({
		"ast-edit": { reflectModel: { providerId: "openrouter", modelId: "nvidia/x:free" } },
	});
	const other = { id: "configured-model", reasoning: true };
	await maybeReflect(pi, {
		...ctx("high"),
		modelRegistry: { ...registry, find: () => other } as unknown as ModelRegistryLike,
	});

	assert.deepEqual(levels, ["high", "low", undefined, "high"]);
	assert.deepEqual(used, [session, session, session, other]);
});

// --- G. resolveReflectModel -------------------------------------------------

test("G1: the configured model wins, everything else falls back to the session model", () => {
	const session = { id: "session-model" };
	const target = { id: "configured-model" };
	const configured = { providerId: "openrouter", modelId: "nvidia/x:free" };
	const registry = {
		find: (provider: string, id: string) =>
			provider === "openrouter" && id === "nvidia/x:free" ? target : undefined,
	};

	assert.equal(resolveReflectModel(registry, session, undefined), session);
	assert.equal(resolveReflectModel(registry, session, configured), target);
	assert.equal(
		resolveReflectModel(registry, session, { providerId: "openrouter", modelId: "unknown" }),
		session,
	);
	// a level-only config (and a half-given model) stays on the session model
	assert.equal(resolveReflectModel(registry, session, { thinkingLevel: "high" }), session);
	assert.equal(resolveReflectModel(registry, session, { providerId: "openrouter" }), session);
	assert.equal(resolveReflectModel(undefined, session, configured), session);
});
