import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildDigest,
	compactRecord,
	defaultTracePath,
	type EditTraceRecord,
	isTraceRecord,
	loadTraceConfig,
	readTraceLog,
	recordEditTrace,
	registerInsightsCommand,
} from "../../tools/insights.ts";

/**
 * Telemetry unit tests (node:test, zero deps). Config tests point
 * PI_CODING_AGENT_DIR at a temp dir; recordEditTrace writes a JSONL trace
 * log under the agent dir.
 */

function withAgentDir(settings: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "piastedit-config-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	return dir;
}

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of dirsToClean) rmSync(dir, { recursive: true, force: true });
	dirsToClean.length = 0;
});
const dirsToClean: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piastedit-test-"));
	dirsToClean.push(dir);
	return dir;
}

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

// --- A. loadTraceConfig -----------------------------------------------------

test("A1: missing settings file -> defaults", () => {
	const dir = tempDir();
	process.env.PI_CODING_AGENT_DIR = dir; // no settings.json written
	assert.deepEqual(loadTraceConfig(), { traceEnabled: false, insightsLines: 300 });
});

test("A2: invalid JSON -> defaults", () => {
	withAgentDir("{ not json");
	assert.deepEqual(loadTraceConfig(), { traceEnabled: false, insightsLines: 300 });
});

test("A3: no piAstEdit key -> defaults", () => {
	withAgentDir({ defaultModel: "x" });
	assert.deepEqual(loadTraceConfig(), { traceEnabled: false, insightsLines: 300 });
});

test("A4: piAstEdit not an object -> defaults", () => {
	for (const bad of ["string", null, [1, 2]]) {
		withAgentDir({ piAstEdit: bad });
		assert.deepEqual(
			loadTraceConfig(),
			{ traceEnabled: false, insightsLines: 300 },
			`piAstEdit=${JSON.stringify(bad)}`,
		);
	}
});

test("A5: traceEnabled boolean honored", () => {
	withAgentDir({ piAstEdit: { traceEnabled: true } });
	assert.equal(loadTraceConfig().traceEnabled, true);
	withAgentDir({ piAstEdit: { traceEnabled: false } });
	assert.equal(loadTraceConfig().traceEnabled, false);
});

test("A6: traceEnabled wrong type ignored", () => {
	for (const bad of ["true", 1]) {
		withAgentDir({ piAstEdit: { traceEnabled: bad } });
		assert.equal(loadTraceConfig().traceEnabled, false, `traceEnabled=${JSON.stringify(bad)}`);
	}
});

test("A7: insightsLines honored", () => {
	withAgentDir({ piAstEdit: { insightsLines: 500 } });
	assert.equal(loadTraceConfig().insightsLines, 500);
});

test("A8: insightsLines 0/negative/string ignored -> default 300", () => {
	for (const bad of [0, -5, "300"]) {
		withAgentDir({ piAstEdit: { insightsLines: bad } });
		assert.equal(loadTraceConfig().insightsLines, 300, `insightsLines=${JSON.stringify(bad)}`);
	}
});

test("A9: insightsLines fraction floored", () => {
	withAgentDir({ piAstEdit: { insightsLines: 2.7 } });
	assert.equal(loadTraceConfig().insightsLines, 2);
});

test("A10: tracePath honored when string, ignored otherwise; default under agent dir", () => {
	withAgentDir({ piAstEdit: { tracePath: "/tmp/custom-trace.jsonl" } });
	assert.equal(loadTraceConfig().tracePath, "/tmp/custom-trace.jsonl");
	for (const bad of [42, true, ""]) {
		withAgentDir({ piAstEdit: { tracePath: bad } });
		assert.equal(loadTraceConfig().tracePath, undefined, `tracePath=${JSON.stringify(bad)}`);
	}
	const dir = tempDir();
	process.env.PI_CODING_AGENT_DIR = dir;
	assert.equal(defaultTracePath(), join(dir, "pi-ast-edit", "edits.jsonl"));
});

// --- B. isTraceRecord / readTraceLog ----------------------------------------

test("B1: isTraceRecord rejects non-records", () => {
	for (const bad of [42, [], {}, null, undefined, "x"]) {
		assert.equal(isTraceRecord(bad), false, JSON.stringify(bad));
	}
	assert.equal(isTraceRecord(record()), true);
});

test("B2: malformed data dropped by readTraceLog", () => {
	const dir = tempDir();
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(
		join(dir, "trace.jsonl"),
		[
			"not json",
			JSON.stringify({ ts: "1700000000000", toolCallId: "c" }), // ts string
			JSON.stringify(record({ path: "ok.js" })),
			"",
		].join("\n"),
	);
	assert.deepEqual(
		readTraceLog(join(dir, "trace.jsonl")).map((r) => r.path),
		["ok.js"],
	);
});

test("B3: missing trace file -> empty", () => {
	assert.deepEqual(readTraceLog("/nonexistent/trace.jsonl"), []);
});

// --- C. compactRecord -------------------------------------------------------

test("C1: full ok record rendered", () => {
	const line = compactRecord(record());
	assert.match(line, /^2023-11-14 22:13:20\.000\s+OK\s+ast-grep\s+src\/x\.js/);
	assert.match(line, /applied=1/);
	assert.match(line, /preErrors=0/);
	assert.match(line, /postErrors=0/);
	assert.match(line, /12ms/);
	assert.match(line, /pattern:`foo\(\$A\)`/);
});

test("C2: error message included with ERROR tag", () => {
	const line = compactRecord(record({ result: "error", error: "matches 2 nodes" }));
	assert.match(line, /ERROR/);
	assert.match(line, /error: matches 2 nodes/);
});

test("C3: aborted and fallback tags", () => {
	assert.match(compactRecord(record({ result: "aborted" })), /ABORTED/);
	const fallback = compactRecord(
		record({ binary: "builtin-fallback", result: "error", error: "no binary" }),
	);
	assert.match(fallback, /fallback/);
	assert.match(fallback, /error: no binary/);
});

test("C4/C5: truncation boundary at 800 chars", () => {
	const short = compactRecord(record({ result: "error", error: "e".repeat(100) }));
	assert.ok(short.length <= 800, `short line ${short.length}`);
	assert.ok(!short.endsWith("…"));
	const long = compactRecord(record({ result: "error", error: "e".repeat(900) }));
	assert.equal(long.length, 800);
	assert.ok(long.endsWith("…"));
});

test("C6: empty edit text -> mode only; multiple edits rendered", () => {
	const line = compactRecord(
		record({
			edits: [
				{ mode: "exact", text: "" },
				{ mode: "pattern", text: "foo($A)" },
			],
		}),
	);
	assert.match(line, /exact/);
	assert.match(line, /pattern:`foo\(\$A\)`/);
	assert.doesNotMatch(line, /exact:`/);
});

// --- D. buildDigest ----------------------------------------------------------

test("D1: empty input -> empty string", () => {
	assert.equal(buildDigest([]), "");
});

test("D2: order preserved, newline-joined", () => {
	const a = record({ path: "a.js" });
	const b = record({ path: "b.js" });
	const digest = buildDigest([a, b]);
	const lines = digest.split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0], /a\.js/);
	assert.match(lines[1], /b\.js/);
});

test("D3: budget boundary — later records skipped once 60k is exhausted", () => {
	// One record can never overflow (C5 caps a line at 800 chars); the budget
	// binds only across many records. 100 × ~800-char lines ≈ 80k > 60k.
	const records = Array.from({ length: 100 }, (_, i) =>
		record({ path: `r${i}.js`, error: "e".repeat(700) }),
	);
	const digest = buildDigest(records);
	assert.ok(digest.length <= 60_000, `digest ${digest.length} chars`);
	const lines = digest.split("\n");
	assert.ok(lines.length < 100, `${lines.length} lines`);
	assert.match(lines[0], /r0/); // most recent first (input order preserved)
	assert.ok(lines.length >= 70); // budget, not an off-by-one, cut the tail
});

// --- E. recordEditTrace (file model) ----------------------------------------

test("E1: trace off by default (no settings) -> no file written", () => {
	const dir = tempDir();
	process.env.PI_CODING_AGENT_DIR = dir;
	assert.doesNotThrow(() => recordEditTrace(record()));
	assert.equal(existsSync(join(dir, "pi-ast-edit", "edits.jsonl")), false);
});

test("E2: traceEnabled false -> no file written", () => {
	const dir = withAgentDir({ piAstEdit: { traceEnabled: false } });
	recordEditTrace(record());
	assert.equal(existsSync(join(dir, "pi-ast-edit", "edits.jsonl")), false);
});

test("E3: traceEnabled true -> one JSON line with all fields", () => {
	const dir = withAgentDir({ piAstEdit: { traceEnabled: true } });
	recordEditTrace(record());
	const log = join(dir, "pi-ast-edit", "edits.jsonl");
	const parsed = readTraceLog(log);
	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0], record());
});

test("E4: records append as lines, order preserved", () => {
	const dir = withAgentDir({ piAstEdit: { traceEnabled: true } });
	recordEditTrace(record({ toolCallId: "a", path: "a.js" }));
	recordEditTrace(record({ toolCallId: "b", path: "b.js" }));
	const parsed = readTraceLog(join(dir, "pi-ast-edit", "edits.jsonl"));
	assert.deepEqual(
		parsed.map((r) => r.path),
		["a.js", "b.js"],
	);
});

test("E5: custom tracePath honored", () => {
	const custom = join(tempDir(), "custom-name.jsonl");
	withAgentDir({
		piAstEdit: { traceEnabled: true, tracePath: custom },
	});
	recordEditTrace(record());
	assert.equal(existsSync(custom), true);
	assert.equal(readTraceLog(custom).length, 1);
});

test("E6: unwritable tracePath swallowed (never throws)", () => {
	const dir = tempDir();
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({
			piAstEdit: { traceEnabled: true, tracePath: join(dir, "blocker", "x.jsonl") },
		}),
	);
	// `blocker` exists as a file, so mkdirSync(dirname) fails with ENOTDIR.
	writeFileSync(join(dir, "blocker"), "i am a file, not a dir");
	assert.doesNotThrow(() => recordEditTrace(record()));
});

// --- F. /ast-edit-insights command ------------------------------------------

/** Fake pi capturing the registered command and sent messages. */
function makeCommandPi() {
	const defs: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
	const sent: string[] = [];
	const pi = {
		registerCommand: (
			name: string,
			def: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => defs.push({ name, handler: def.handler }),
		sendUserMessage: (msg: string) => sent.push(msg),
	} as unknown as ExtensionAPI;
	registerInsightsCommand(pi);
	const found = defs.find((d) => d.name === "ast-edit-insights");
	assert.ok(found, "ast-edit-insights registered");
	return { handler: found.handler, sent };
}

function sessionCtx(sessionId: string, notices: string[]): unknown {
	return {
		ui: { notify: (msg: string) => notices.push(msg) },
		sessionManager: { getSessionId: () => sessionId },
	};
}

test("F1: filters to current session, most recent first, sends digest", async () => {
	const dir = withAgentDir({ piAstEdit: { traceEnabled: true } });
	mkdirSync(join(dir, "pi-ast-edit"));
	const log = join(dir, "pi-ast-edit", "edits.jsonl");
	const recs = [
		record({ toolCallId: "1", sessionId: "s1", path: "one.js" }),
		record({ toolCallId: "2", sessionId: "s2", path: "two.js" }),
		record({ toolCallId: "3", sessionId: "s1", path: "three.js" }),
	];
	writeFileSync(log, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");

	const { handler, sent } = makeCommandPi();
	await handler("", sessionCtx("s1", []));

	assert.ok(sent.length === 1, "sendUserMessage called once");
	const msg = sent[0];
	assert.match(msg, /three\.js/);
	assert.match(msg, /one\.js/);
	assert.doesNotMatch(msg, /two\.js/); // other session filtered out
	// most recent first: three.js before one.js
	assert.ok(msg.indexOf("three.js") < msg.indexOf("one.js"));
});

test("F2: no records for session -> notify, no send", async () => {
	const dir = withAgentDir({ piAstEdit: { traceEnabled: true } });
	mkdirSync(join(dir, "pi-ast-edit"));
	writeFileSync(
		join(dir, "pi-ast-edit", "edits.jsonl"),
		JSON.stringify(record({ sessionId: "s2" })) + "\n",
	);

	const { handler, sent } = makeCommandPi();
	const notices: string[] = [];
	await handler("", sessionCtx("s1", notices));

	assert.equal(sent.length, 0);
	assert.ok(notices.length === 1 && notices[0].includes("no recorded edit calls"));
});

test("F3: missing trace file -> notify, no send", async () => {
	withAgentDir({ piAstEdit: { traceEnabled: true } });
	const { handler, sent } = makeCommandPi();
	const notices: string[] = [];
	await handler("", sessionCtx("s1", notices));
	assert.equal(sent.length, 0);
	assert.ok(notices.length === 1 && notices[0].includes("no recorded edit calls"));
});

test("F4: N and all arguments honored", async () => {
	const dir = withAgentDir({ piAstEdit: { traceEnabled: true } });
	mkdirSync(join(dir, "pi-ast-edit"));
	const recs = Array.from({ length: 5 }, (_, i) =>
		record({ toolCallId: `${i}`, sessionId: "s1", path: `r${i}.js` }),
	);
	writeFileSync(
		join(dir, "pi-ast-edit", "edits.jsonl"),
		recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
	);

	const { handler, sent } = makeCommandPi();
	await handler("2", sessionCtx("s1", []));
	// tail 2, most recent first
	assert.ok(sent[0].indexOf("r4.js") > -1 && sent[0].indexOf("r3.js") > -1);
	assert.ok(sent[0].indexOf("r4.js") < sent[0].indexOf("r3.js"));
	assert.doesNotMatch(sent[0], /r2\.js/);

	await handler("all", sessionCtx("s1", []));
	assert.equal((sent[1].match(/r\d\.js/g) ?? []).length, 5);
	assert.ok(sent[1].indexOf("r4.js") < sent[1].indexOf("r0.js")); // most recent first
});
