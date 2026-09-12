import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
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
	resolveReflectModel,
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
function editCall(id: string, path: string, edits: unknown[]) {
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

test("A9: reflectModel honored when a non-empty string, ignored otherwise", () => {
	withAgentDir({ "ast-edit": { reflectModel: "openrouter/nvidia/nemotron:free" } });
	assert.equal(loadTraceConfig().reflectModel, "openrouter/nvidia/nemotron:free");
	for (const bad of [42, true, ""]) {
		withAgentDir({ "ast-edit": { reflectModel: bad } });
		assert.equal(loadTraceConfig().reflectModel, undefined, `reflectModel=${JSON.stringify(bad)}`);
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

test("C2: path/edits come from the matching tool call; missing call degrades", () => {
	const entries = [
		editCall("c2", "lib/y.ts", [{ oldText: "a", newText: "b" }, { pattern: "q($A)" }]),
		toolResult("c2", "edit", true, "boom"),
		toolResult("orphan", "edit", true, "no call for me"),
	];
	const failures = failedEdits(entries);
	assert.equal(failures.length, 2);
	assert.equal(failures[0].path, "lib/y.ts");
	assert.equal(failures[0].edits, "exact:`a`  pattern:`q($A)`");
	assert.equal(failures[1].path, "(unknown path)");
	assert.equal(failures[1].edits, "");
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

test("F5: reflectModel override is used when it resolves", async () => {
	withAgentDir({ "ast-edit": { reflectModel: "openrouter/nvidia/x:free" } });
	const { registry, calls } = fakeRegistry("configured rules");
	const used: unknown[] = [];
	const tracking = {
		find: (provider: string, id: string) => ({ provider, id, tag: "configured" }),
		complete: async (model: unknown, context: unknown) => {
			used.push(model);
			return (
				registry as unknown as { complete: (m: unknown, c: unknown) => Promise<unknown> }
			).complete(model, context);
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
	assert.deepEqual(used, [{ provider: "openrouter", id: "nvidia/x:free", tag: "configured" }]);
});

// --- G. resolveReflectModel -------------------------------------------------

test("G1: configured model wins, everything else falls back to the session model", () => {
	const session = { id: "session-model" };
	const target = { id: "configured-model" };
	const registry = {
		find: (provider: string, id: string) =>
			provider === "openrouter" && id === "nvidia/x:free" ? target : undefined,
	};

	assert.equal(resolveReflectModel(registry, session, undefined), session);
	assert.equal(resolveReflectModel(registry, session, "openrouter/nvidia/x:free"), target);
	assert.equal(resolveReflectModel(registry, session, "openrouter/unknown"), session);
	for (const bad of ["no-slash", "/leading", "trailing/"]) {
		assert.equal(resolveReflectModel(registry, session, bad), session, bad);
	}
	assert.equal(resolveReflectModel(undefined, session, "openrouter/nvidia/x:free"), session);
});
