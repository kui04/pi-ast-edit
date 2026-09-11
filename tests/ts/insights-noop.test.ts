import assert from "node:assert/strict";
import { test } from "node:test";
import { recordEditTrace, type EditTraceRecord } from "../../tools/insights.ts";

/**
 * E1: recordEditTrace before any initInsights() call must no-op silently.
 * Lives in its own file: node:test gives each test file a fresh process, and
 * the module-level `piRef` in insights.ts is only set by initInsights().
 */

function record(): EditTraceRecord {
	return {
		ts: 1_700_000_000_000,
		toolCallId: "call_1",
		binary: "ast-grep",
		edits: [],
		path: "x.js",
		result: "ok",
		applied: 1,
		preErrors: 0,
		postErrors: 0,
		ms: 1,
	};
}

test("E1: no pi wired -> no-op, no throw", () => {
	assert.doesNotThrow(() => recordEditTrace(record()));
});