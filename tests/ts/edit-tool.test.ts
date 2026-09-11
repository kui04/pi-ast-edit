import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "../../tools/edit-tool.ts";
import { initInsights, type EditTraceRecord } from "../../tools/insights.ts";

/**
 * F: execute-wrapper integration tests. Drive the real `edit` tool through
 * the public registerEditTool() surface against the compiled binary
 * (PI_AST_EDIT_BIN); telemetry is captured via a fake pi appendEntry spy.
 * Skipped when the binary isn't built — same check `nix build`/dev builds
 * produce.
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "target", "debug", "pi-ast-edit");
const hasBinary = existsSync(BIN);

const agentDir = mkdtempSync(join(tmpdir(), "piastedit-agent-"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ piAstEdit: { traceEnabled: true } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_AST_EDIT_BIN = BIN;

const cwd = mkdtempSync(join(tmpdir(), "piastedit-cwd-"));

const appended: EditTraceRecord[] = [];
const capturePi = {
	registerCommand: () => {},
	appendEntry: (_t: string, data?: unknown) => appended.push(data as EditTraceRecord),
} as unknown as ExtensionAPI;
initInsights(capturePi);

const recorders: Array<{ name: string; parameters: unknown; execute: Function }> = [];
const toolPi = {
	registerTool: (t: { name: string; parameters: unknown; execute: Function }) => recorders.push(t),
} as unknown as ExtensionAPI;
registerEditTool(toolPi);
const editTool = recorders[0];
const ctx = { cwd } as never;

after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_AST_EDIT_BIN;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

async function runEdit(path: string, edits: unknown[], signal?: AbortSignal) {
	return editTool.execute(`call-${Math.random().toString(36).slice(2)}`, { path, edits }, signal, undefined, ctx);
}

function file(name: string, content: string): string {
	const p = join(cwd, name);
	writeFileSync(p, content);
	return p;
}

test("F1: pattern edit success records ok with applied count", { skip: !hasBinary }, async () => {
	const path = file("a.js", "foo(1);");
	const before = appended.length;
	const result = await runEdit(path, [{ pattern: "foo($A)", replace: "bar($A)" }]);
	assert.match(result.content[0].text, /Applied 1 edit/);
	assert.equal(readFileSync(path, "utf8"), "bar(1);");
	const rec = appended[appended.length - 1];
	assert.equal(rec.result, "ok");
	assert.equal(rec.applied, 1);
	assert.equal(rec.edits[0].mode, "pattern");
});

test("F2: ambiguous pattern -> error record, file unchanged", { skip: !hasBinary }, async () => {
	const path = file("b.js", "foo(1); foo(2);");
	const original = readFileSync(path, "utf8");
	await assert.rejects(
		runEdit(path, [{ pattern: "foo($A)", replace: "bar($A)" }]),
		/matches 2 nodes/,
	);
	assert.equal(readFileSync(path, "utf8"), original);
	const rec = appended[appended.length - 1];
	assert.equal(rec.result, "error");
	assert.match(rec.error ?? "", /matches 2 nodes/);
});

test("F3: missing file -> error record", { skip: !hasBinary }, async () => {
	await assert.rejects(runEdit(join(cwd, "missing.js"), [{ oldText: "x", newText: "y" }]), /Could not edit file/);
	const rec = appended[appended.length - 1];
	assert.equal(rec.result, "error");
	assert.match(rec.error ?? "", /Could not edit file/);
});

test("F4: aborted signal -> aborted record", { skip: !hasBinary }, async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		runEdit(file("c.js", "foo(1);"), [{ pattern: "foo($A)", replace: "bar($A)" }], controller.signal),
		/aborted/i,
	);
	const rec = appended[appended.length - 1];
	assert.equal(rec.result, "aborted");
});

test("F5: exact oldText edit records mode exact", { skip: !hasBinary }, async () => {
	const path = file("d.txt", "hello world");
	const result = await runEdit(path, [{ oldText: "world", newText: "there" }]);
	assert.match(result.content[0].text, /Applied 1 edit/);
	assert.equal(readFileSync(path, "utf8"), "hello there");
	const rec = appended[appended.length - 1];
	assert.equal(rec.result, "ok");
	assert.equal(rec.edits[0].mode, "exact");
});