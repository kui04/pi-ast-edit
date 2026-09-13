import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFindTool } from "../../tools/find-tool.ts";

/**
 * I: ast_find integration through the real binary (PI_AST_EDIT_BIN). Covers the
 * empty-sentinel regression end to end: a payload carrying `position: ""` used
 * to reach the binary as `--position ""` and fail with `invalid position`.
 * Skipped when the binary isn't built — same check `nix build`/dev builds
 * produce.
 */

const BIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"target",
	"debug",
	"pi-ast-edit",
);
const hasBinary = existsSync(BIN);
process.env.PI_AST_EDIT_BIN = BIN;

const cwd = mkdtempSync(join(tmpdir(), "piastedit-find-"));

type ToolLike = {
	name: string;
	prepareArguments?: (args: unknown) => unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }> }>;
};

const tools: ToolLike[] = [];
registerFindTool({ registerTool: (t: ToolLike) => tools.push(t) } as unknown as ExtensionAPI);
const findTool = tools[0];
const ctx = { cwd, sessionManager: { getSessionId: () => "test-session" } } as never;

after(() => {
	delete process.env.PI_AST_EDIT_BIN;
	rmSync(cwd, { recursive: true, force: true });
});

function file(name: string, content: string): string {
	const path = join(cwd, name);
	writeFileSync(path, content);
	return path;
}

/** Registered-tool path with the same shim pi applies before execute(). */
async function runFind(params: Record<string, unknown>): Promise<string> {
	const prepared = findTool.prepareArguments?.(params) ?? params;
	const result = await findTool.execute("call-find", prepared, undefined, undefined, ctx);
	return result.content[0].text;
}

test("I1: full-template args with empty position search by pattern", {
	skip: !hasBinary,
}, async () => {
	const path = file("a.js", "foo(1);\nbar(2);\n");
	const text = await runFind({
		path,
		pattern: "foo($A)",
		context: "",
		kind: "",
		position: "",
		limit: 5,
	});
	assert.match(text, /Found 1 match\(es\)/);
	assert.match(text, /line 1, col 1/);
	assert.match(text, /foo\(1\)/);
});

test("I2: a real position still survives pruning", { skip: !hasBinary }, async () => {
	const path = file("b.js", "foo(1);\nbar(2);\n");
	const text = await runFind({
		path,
		pattern: "bar($A)",
		context: "",
		kind: "",
		position: "2:1",
		limit: 5,
	});
	assert.match(text, /Node at 2:1/);
	assert.match(text, /identifier \(2:1-2:4\): bar/);
	assert.match(text, /call_expression/);
});
