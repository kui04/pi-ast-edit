import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pruneSentinels } from "../../tools/args.ts";
import { registerEditTool } from "../../tools/edit-tool.ts";
import { registerFindTool } from "../../tools/find-tool.ts";

/**
 * H: empty-sentinel pruning (tools/args.ts) — the pure helper plus both tool
 * registration surfaces. Models that fill every optional schema field encode
 * "unused" as `""` / `false` / `null`; these tests pin what is dropped and,
 * just as important, what is kept. No binary needed.
 */

type ToolLike = { name: string; prepareArguments?: (args: unknown) => unknown };
const tools: ToolLike[] = [];
const pi = { registerTool: (tool: ToolLike) => tools.push(tool) } as unknown as ExtensionAPI;
registerEditTool(pi);
registerFindTool(pi);
const editTool = tools.find((tool) => tool.name === "edit");
const findTool = tools.find((tool) => tool.name === "ast_find");
assert.ok(editTool, "edit tool registered");
assert.ok(findTool, "ast_find tool registered");

/** Verbatim payload of a real failing call (session 2026-09-12, dialog.dart). */
const FULL_TEMPLATE = {
	all: false,
	context: "",
	delete: false,
	insertAfter: "",
	insertBefore: "",
	matchIndex: null,
	newText: "b",
	oldText: "a",
	pattern: "",
	replace: "",
};

test("H1: edit drops empty sentinels, keeps real values", () => {
	const out = editTool.prepareArguments?.({ path: "x.js", edits: [FULL_TEMPLATE] }) as {
		edits: Array<Record<string, unknown>>;
	};
	assert.deepEqual(out.edits[0], { oldText: "a", newText: "b" });
});

test('H2: edit keeps newText:"" and matchIndex 0', () => {
	const out = editTool.prepareArguments?.({
		path: "x.js",
		edits: [
			{
				pattern: "foo($A)",
				replace: "",
				newText: "",
				matchIndex: 0,
				context: "",
				insertBefore: "",
				insertAfter: "",
				delete: false,
				all: false,
			},
		],
	}) as { edits: Array<Record<string, unknown>> };
	assert.deepEqual(out.edits[0], { pattern: "foo($A)", newText: "", matchIndex: 0 });
});

test("H3: legacy top-level oldText/newText still normalizes", () => {
	const out = editTool.prepareArguments?.({ path: "x.json", oldText: "a", newText: "b" }) as {
		edits: Array<Record<string, unknown>>;
	};
	assert.deepEqual(out.edits, [{ oldText: "a", newText: "b" }]);
});

test("H4: non-object edits are left for validation to report", () => {
	const out = editTool.prepareArguments?.({ path: "x.js", edits: ["nope"] }) as {
		edits: unknown[];
	};
	assert.deepEqual(out.edits, ["nope"]);
});

test("H5: ast_find drops empty position/context/kind", () => {
	const out = findTool.prepareArguments?.({
		path: "x.dart",
		pattern: "BorderRadius.circular(12)",
		context: "",
		kind: "",
		position: "",
		limit: 5,
	}) as Record<string, unknown>;
	assert.deepEqual(out, {
		path: "x.dart",
		pattern: "BorderRadius.circular(12)",
		limit: 5,
	});
});

test("H6: only the listed keys are pruned; null always is", () => {
	const out = pruneSentinels(
		{ a: "", b: "", c: false, d: false, e: null, f: "x" },
		{ emptyStrings: ["b"], falseBooleans: ["d"] },
	);
	assert.deepEqual(out, { a: "", c: false, f: "x" });
});

test("H7: pruning applies to every edit in the array", () => {
	const out = editTool.prepareArguments?.({
		path: "x.js",
		edits: [FULL_TEMPLATE, { ...FULL_TEMPLATE, oldText: "c", newText: "d" }],
	}) as { edits: Array<Record<string, unknown>> };
	assert.deepEqual(out.edits, [
		{ oldText: "a", newText: "b" },
		{ oldText: "c", newText: "d" },
	]);
});
