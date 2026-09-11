import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildDigest,
	compactRecord,
	initInsights,
	isTraceRecord,
	loadTraceConfig,
	recordEditTrace,
	traceEntries,
	type EditTraceRecord,
} from "../../tools/insights.ts";

/**
 * Telemetry unit tests (node:test, zero deps). Config tests point
 * PI_CODING_AGENT_DIR at a temp dir; recordEditTrace uses a fake pi whose
 * appendEntry collects calls.
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

function record(overrides: Partial<EditTraceRecord> = {}): EditTraceRecord {
	return {
		ts: 1_700_000_000_000,
		toolCallId: "call_1",
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

function fakePi(appended: Array<[string, unknown]>): ExtensionAPI {
	return {
		registerCommand: () => {},
		appendEntry: (type: string, data?: unknown) => appended.push([type, data]),
	} as unknown as ExtensionAPI;
}

// --- A. loadTraceConfig -----------------------------------------------------

test("A1: missing settings file -> defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "piastedit-config-"));
	dirsToClean.push(dir);
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
		assert.deepEqual(loadTraceConfig(), { traceEnabled: false, insightsLines: 300 }, `piAstEdit=${JSON.stringify(bad)}`);
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

// --- B. traceEntries / isTraceRecord ----------------------------------------

test("B1: matching custom entry kept", () => {
	const rec = record();
	const ctx = { sessionManager: { getEntries: () => [{ type: "custom", customType: "piAstEditTrace", data: rec }] } };
	assert.deepEqual(traceEntries(ctx).map((e) => e.data), [rec]);
});

test("B2: other customType dropped", () => {
	const ctx = { sessionManager: { getEntries: () => [{ type: "custom", customType: "other-ext", data: record() }] } };
	assert.deepEqual(traceEntries(ctx), []);
});

test("B3: custom_message entry dropped", () => {
	const ctx = {
		sessionManager: { getEntries: () => [{ type: "custom_message", customType: "piAstEditTrace", content: "" }] },
	};
	assert.deepEqual(traceEntries(ctx), []);
});

test("B4: missing/undefined data dropped", () => {
	const ctx = { sessionManager: { getEntries: () => [{ type: "custom", customType: "piAstEditTrace" }] } };
	assert.deepEqual(traceEntries(ctx), []);
});

test("B5: malformed data dropped", () => {
	const malformed: unknown[] = [
		{ ts: "1700000000000", toolCallId: "c" }, // ts string
		{ ts: 1, toolCallId: 42 }, // toolCallId not string
		null,
		[],
		{},
	];
	for (const data of malformed) {
		const ctx = { sessionManager: { getEntries: () => [{ type: "custom", customType: "piAstEditTrace", data }] } };
		assert.deepEqual(traceEntries(ctx), [], JSON.stringify(data));
	}
});

test("B6: isTraceRecord rejects non-objects", () => {
	for (const bad of [42, [], {}, null, undefined, "x"]) {
		assert.equal(isTraceRecord(bad), false, JSON.stringify(bad));
	}
	assert.equal(isTraceRecord(record()), true);
});

// --- C. compactRecord --------------------------------------------------------

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
	const fallback = compactRecord(record({ binary: "builtin-fallback", result: "error", error: "no binary" }));
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

// --- E. recordEditTrace ------------------------------------------------------

test("E2: traceEnabled false -> no append", () => {
	withAgentDir({});
	const appended: Array<[string, unknown]> = [];
	initInsights(fakePi(appended));
	recordEditTrace(record());
	assert.equal(appended.length, 0);
});

test("E3: traceEnabled true -> one append with custom type and record", () => {
	withAgentDir({ piAstEdit: { traceEnabled: true } });
	const appended: Array<[string, unknown]> = [];
	initInsights(fakePi(appended));
	const rec = record();
	recordEditTrace(rec);
	assert.equal(appended.length, 1);
	assert.equal(appended[0][0], "piAstEditTrace");
	assert.equal(appended[0][1], rec);
});

test("E4: appendEntry throwing is swallowed", () => {
	withAgentDir({ piAstEdit: { traceEnabled: true } });
	const pi = {
		registerCommand: () => {},
		appendEntry: () => {
			throw new Error("disk full");
		},
	} as unknown as ExtensionAPI;
	initInsights(pi);
	assert.doesNotThrow(() => recordEditTrace(record()));
});