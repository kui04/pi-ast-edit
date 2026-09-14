import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentToolResult,
	createEditToolDefinition,
	type EditToolDetails,
	generateDiffString,
	generateUnifiedPatch,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { pruneSentinels, type SentinelRules } from "./args.ts";
import { callBinary, findBinary, redownloadInBackground } from "./binary.ts";
import { recordEditTrace } from "./reflect.ts";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.Optional(
				Type.String({
					description:
						'Exact text to replace (built-in compatible mode). Matched structurally first when the file\'s language is supported (whole AST nodes whose text is byte-identical to oldText), falling back to byte-exact text search. Needs newText (pass "" to delete); insertBefore/insertAfter/delete/replace are structural-mode arguments and are rejected here.',
				}),
			),
			newText: Type.Optional(
				Type.String({ description: "Replacement text for oldText (used verbatim)." }),
			),
			pattern: Type.Optional(
				Type.String({
					description:
						'ast-grep structural pattern, e.g. "foo($A)". Whitespace-insensitive, matched as whole AST nodes (never inside strings/comments). $A captures one node, $$$A captures zero or more, $$$ matches without capturing, $_ matches one node without capturing. Variable names must be UPPERCASE ($foo is literal text). Same-name variables must match identical code. One pattern matches one node — capture sequences explicitly, e.g. "function f($$$ARGS) { $$$BODY }".',
				}),
			),
			replace: Type.Optional(
				Type.String({
					description:
						"Replacement for pattern matches. Every $VAR must be captured in pattern with the same arity ($A needs $A, $$$A needs $$$A); uncaptured variables are rejected, not silently dropped.",
				}),
			),
			insertBefore: Type.Optional(
				Type.String({ description: "Insert this code immediately before each matched node." }),
			),
			insertAfter: Type.Optional(
				Type.String({
					description:
						"Insert this code immediately after each matched node (after trailing punctuation). Must be valid standalone code.",
				}),
			),
			delete: Type.Optional(
				Type.Boolean({
					description:
						'Delete the matched node(s) entirely. Removes only the node — include trailing punctuation in the pattern (e.g. "foo();") to delete a whole statement.',
				}),
			),
			context: Type.Optional(
				Type.String({
					description:
						'Only match nodes inside a match of this pattern, e.g. "function foo() { $$$ }".',
				}),
			),
			matchIndex: Type.Optional(
				Type.Number({
					description:
						"0-based index of the match to edit when the pattern matches multiple nodes.",
				}),
			),
			all: Type.Optional(
				Type.Boolean({
					description:
						"Apply the edit to every (non-nested) match instead of requiring a unique match.",
				}),
			),
		}),
		{
			description:
				"One or more edits. Each edit uses either oldText/newText (exact mode) or pattern plus exactly one of replace/insertBefore/insertAfter/delete (structural mode).",
		},
	),
});

type EditInput = Static<typeof editSchema>;

interface EditBinaryResult {
	newContent: string;
	applied: Array<{
		op: string;
		pattern: string;
		matchedText: string;
		newText: string;
		line: number;
		col: number;
		kind: string;
	}>;
	preErrors: Array<{ line: number; col: number; text: string }>;
	postErrors: Array<{ line: number; col: number; text: string }>;
}

/** Optional edit fields where `""` / `false` means "not provided". */
const EDIT_SENTINELS: SentinelRules = {
	emptyStrings: ["oldText", "pattern", "replace", "insertBefore", "insertAfter", "context"],
	falseBooleans: ["delete", "all"],
};

/** Compatibility shim for the built-in edit tool's accepted input shapes. */
function prepareArguments(args: unknown): EditInput {
	const input = normalizeEditArgs(args);
	const edits = (input as { edits?: unknown }).edits;
	if (!Array.isArray(edits)) return input;
	return {
		...input,
		edits: edits.map((edit) =>
			edit && typeof edit === "object"
				? pruneSentinels(edit as Record<string, unknown>, EDIT_SENTINELS)
				: edit,
		),
	} as EditInput;
}

/** Input shapes: `edits` as a JSON string, a single edit object, or legacy top-level oldText/newText. */
function normalizeEditArgs(args: unknown): EditInput {
	if (!args || typeof args !== "object") return args as EditInput;
	const input = args as Record<string, unknown>;

	// Some models send edits as a JSON string, or a single edit object.
	if (typeof input.edits === "string") {
		try {
			const parsed = JSON.parse(input.edits);
			if (Array.isArray(parsed)) {
				input.edits = parsed;
			} else if (isSingleEdit(parsed)) {
				input.edits = [parsed];
			}
		} catch {
			// leave as-is; schema validation will report it
		}
	} else if (isSingleEdit(input.edits)) {
		input.edits = [input.edits];
	}

	// Legacy top-level oldText/newText shape.
	const legacy = input as { oldText?: unknown; newText?: unknown };
	if (typeof legacy.oldText === "string" && typeof legacy.newText === "string") {
		const edits = Array.isArray(input.edits) ? [...(input.edits as unknown[])] : [];
		edits.push({ oldText: legacy.oldText, newText: legacy.newText });
		const { oldText: _oldText, newText: _newText, ...rest } = input;
		return { ...rest, edits } as EditInput;
	}
	return args as EditInput;
}

function isSingleEdit(value: unknown): value is { oldText: string; newText: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { oldText?: unknown }).oldText === "string" &&
		typeof (value as { newText?: unknown }).newText === "string"
	);
}

function snippet(text: string, max = 60): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Pure rendering of the binary's edit result; kept out of execute. */
function formatEditResult(
	path: string,
	applied: EditBinaryResult["applied"],
	preErrors: EditBinaryResult["preErrors"],
	postErrors: EditBinaryResult["postErrors"],
): string {
	const lines: string[] = [`Applied ${applied.length} edit(s) to ${path}:`];
	applied.forEach((a, i) => {
		const where = `line ${a.line}, col ${a.col}`;
		if (a.op === "replace") {
			lines.push(
				`  [${i}] replace ${a.kind} at ${where}: ${snippet(a.matchedText)} → ${snippet(a.newText)}`,
			);
		} else if (a.op === "delete") {
			lines.push(`  [${i}] delete ${a.kind} at ${where}: ${snippet(a.matchedText)}`);
		} else {
			lines.push(
				`  [${i}] ${a.op === "insert_before" ? "insert before" : "insert after"} ${a.kind} at ${where}: ${snippet(a.newText)}`,
			);
		}
	});
	if (preErrors.length > 0) {
		lines.push(
			`Note: file had ${preErrors.length} pre-existing syntax error(s) (first: line ${preErrors[0].line}: ${preErrors[0].text})`,
		);
	}
	if (postErrors.length > 0) {
		lines.push(
			`Warning: file now has ${postErrors.length} syntax error(s) (first: line ${postErrors[0].line}: ${postErrors[0].text})`,
		);
	}
	return lines.join("\n");
}

/** Agent-facing notice prepended to a fallback edit result. */
const MISSING_BINARY_NOTICE = [
	"pi-ast-edit binary is unavailable, so this edit was applied by pi's built-in",
	"exact-text editor instead of ast-grep (oldText/newText now match exactly; no",
	"whitespace-insensitive AST matching). A background re-download was started —",
	"reinstall or rebuild the extension to restore ast-grep editing.",
].join(" ");

/** Short user-facing warning — rendered on its own notify line, not in the input. */
const MISSING_BINARY_WARNING =
	"pi-ast-edit binary missing — using built-in edit fallback (re-downloading).";

const MISSING_BINARY_STRUCTURAL = [
	"pi-ast-edit binary is unavailable: edits using pattern/replace/insertBefore/",
	"insertAfter/delete need it and were NOT applied. Retry with oldText/newText",
	"(exact text), or restore the binary by reinstalling the extension.",
	"A background re-download was started.",
].join(" ");

let warnedMissing = false;

type BuiltinEdit = { oldText: string; newText: string };

/** Built-in edit entries, or null when any edit needs the ast-grep binary. */
function toBuiltinEdits(edits: EditInput["edits"]): BuiltinEdit[] | null {
	const out: BuiltinEdit[] = [];
	for (const e of edits) {
		if (typeof e.oldText !== "string" || typeof e.newText !== "string") return null;
		if (
			e.pattern !== undefined ||
			e.replace !== undefined ||
			e.insertBefore !== undefined ||
			e.insertAfter !== undefined ||
			e.delete !== undefined ||
			e.context !== undefined ||
			e.matchIndex !== undefined ||
			e.all !== undefined
		) {
			return null;
		}
		out.push({ oldText: e.oldText, newText: e.newText });
	}
	return out;
}

/**
 * Binary missing: warn the user once, start a background re-download, and
 * keep the agent working — plain oldText/newText edits run through pi's
 * built-in editor; structural (ast-grep) edits return an explanatory error.
 */
async function builtinFallback(
	toolCallId: string,
	path: string,
	params: EditInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
) {
	if (!warnedMissing) {
		warnedMissing = true;
		// console.* from extensions renders inside the TUI input line, so only
		// use it when there is no UI (print/RPC); otherwise use the notify line.
		if (ctx.hasUI) ctx.ui.notify(MISSING_BINARY_WARNING, "warning");
		else console.warn(`pi-ast-edit: ${MISSING_BINARY_WARNING}`);
	}
	redownloadInBackground();
	const edits = toBuiltinEdits(params.edits);
	if (!edits) throw new Error(MISSING_BINARY_STRUCTURAL);
	const result = await createEditToolDefinition(ctx.cwd).execute(
		toolCallId,
		{ path, edits },
		signal,
		undefined,
		ctx,
	);
	return {
		...result,
		content: [{ type: "text" as const, text: MISSING_BINARY_NOTICE }, ...result.content],
	};
}

interface EditOutcome {
	toolResult: AgentToolResult<EditToolDetails | undefined>;
	binary: "ast-grep" | "builtin-fallback";
	applied: number;
	preErrors: number;
	postErrors: number;
}

async function performEdit(
	toolCallId: string,
	params: EditInput,
	signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
): Promise<EditOutcome> {
	const rawPath = params.path;
	const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;

	if (!findBinary()) {
		const toolResult = await builtinFallback(toolCallId, path, params, signal, ctx);
		return { toolResult, binary: "builtin-fallback", applied: 0, preErrors: 0, postErrors: 0 };
	}
	warnedMissing = false;

	const absolutePath = resolve(ctx.cwd, path);

	return withFileMutationQueue(absolutePath, async () => {
		const throwIfAborted = (): void => {
			if (signal?.aborted) throw new Error("Operation aborted");
		};
		throwIfAborted();

		try {
			await access(absolutePath, constants.R_OK | constants.W_OK);
		} catch (error: unknown) {
			throwIfAborted();
			const code =
				error instanceof Error && "code" in error ? ` (${(error as { code?: string }).code})` : "";
			throw new Error(`Could not edit file: ${path}.${code}`);
		}
		throwIfAborted();

		const raw = await readFile(absolutePath, "utf8");
		throwIfAborted();

		// BOM and line endings are handled here; the binary works on LF text.
		const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
		const content = bom ? raw.slice(1) : raw;
		const crlf = content.includes("\r\n");
		const lf = crlf ? content.replace(/\r\n/g, "\n") : content;

		const result = await callBinary<EditBinaryResult>(
			["edit", "--path", absolutePath],
			JSON.stringify({ content: lf, edits: params.edits }),
		);
		throwIfAborted();

		const newLf = result.newContent;
		const finalContent = bom + (crlf ? newLf.replace(/\n/g, "\r\n") : newLf);
		await writeFile(absolutePath, finalContent, "utf8");
		throwIfAborted();

		const { diff, firstChangedLine } = generateDiffString(lf, newLf);
		const patch = generateUnifiedPatch(path, lf, newLf);

		const text = formatEditResult(path, result.applied, result.preErrors, result.postErrors);
		const details: EditToolDetails = { diff, patch, firstChangedLine };
		return {
			toolResult: { content: [{ type: "text" as const, text }], details },
			binary: "ast-grep",
			applied: result.applied.length,
			preErrors: result.preErrors.length,
			postErrors: result.postErrors.length,
		};
	});
}

/**
 * Public execute: runs the edit and appends one telemetry record per call to
 * the trace log (recordEditTrace never throws, so it cannot break an edit).
 */
async function execute(
	toolCallId: string,
	params: EditInput,
	signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const startedAt = Date.now();
	const binary: "ast-grep" | "builtin-fallback" = findBinary() ? "ast-grep" : "builtin-fallback";
	const edits = (params.edits ?? []).map((e) => ({
		mode: (e.pattern !== undefined ? "pattern" : "exact") as "pattern" | "exact",
		text: snippet(e.pattern ?? e.oldText ?? "", 120),
	}));
	const base = {
		toolCallId,
		sessionId: (
			ctx.sessionManager as { getSessionId?: () => string } | undefined
		)?.getSessionId?.(),
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		path: params.path,
		binary,
		edits,
	};
	try {
		const outcome = await performEdit(toolCallId, params, signal, _onUpdate, ctx);
		recordEditTrace({
			...base,
			ts: startedAt,
			result: "ok",
			applied: outcome.applied,
			preErrors: outcome.preErrors,
			postErrors: outcome.postErrors,
			ms: Date.now() - startedAt,
		});
		return outcome.toolResult;
	} catch (error: unknown) {
		recordEditTrace({
			...base,
			ts: startedAt,
			result: signal?.aborted ? "aborted" : "error",
			applied: 0,
			preErrors: 0,
			postErrors: 0,
			error: snippet(error instanceof Error ? error.message : String(error), 500),
			ms: Date.now() - startedAt,
		});
		throw error;
	}
}

export function registerEditTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit (ast-grep)",
		description: [
			"Edit a single file. Two modes per edit:",
			"- Exact mode: oldText + newText — exact text replacement (built-in compatible). When the file's language is supported, oldText is matched structurally first (whole AST nodes whose text is byte-identical to oldText, so comments and strings are skipped), falling back to byte-exact text search. Exact mode takes no structural argument: insertBefore/insertAfter/delete/replace with oldText are rejected — use pattern for those, or insert as text (newText = <new code> + oldText, or oldText + <new code>).",
			'- Structural mode: pattern + one of replace / insertBefore / insertAfter / delete. Patterns are ast-grep syntax: whitespace-insensitive; $A captures one node, $$$A captures zero or more nodes, $$$ matches any nodes, $_ matches one node without capturing. Variable names must be UPPERCASE ($foo is literal text). Same-name variables must match identical code. One pattern matches one node — capture sequences explicitly (e.g. function body: "function f($$$ARGS) { $$$BODY }"). replace may reference captures ($A, $$$A) with matching arity; every variable in replace must be captured in pattern. context restricts matches to inside a match of another pattern.',
			'Safety: replacement text is parsed and must be valid code; the whole file is re-parsed after editing and the edit is rejected (file unchanged) if it would introduce new syntax errors. delete removes only the matched node — include trailing punctuation (e.g. "foo();") to remove a whole statement; insertBefore/insertAfter text must be valid standalone code. If a pattern matches multiple nodes, the edit fails and lists all matches with 0-based indices — add matchIndex to pick one, all: true to edit every non-nested match, or narrow the pattern. Unsupported file types (e.g. .txt, .vue, .toml) fall back to exact text replacement.',
		].join("\n"),
		promptSnippet:
			"Edit files with AST-aware structural matching (ast-grep): whitespace-insensitive patterns, $VAR capture, validated replacements",
		promptGuidelines: [
			"Use edit with pattern + replace for code changes: patterns match whole AST nodes, ignore whitespace, never match inside strings/comments. Capture with $A (one node) / $$$A (zero or more); names must be UPPERCASE, and every $VAR in replace must be captured in pattern with the same arity.",
			"One edit pattern matches one node: capture sequences explicitly, e.g. a function body as { $$$BODY }, an argument list as ($$$ARGS). Same-name variables must match identical code.",
			"Preview a risky pattern with ast_find before using it in edit — ast_find lists matches in order, which is edit's matchIndex order. When edit reports multiple matches, add matchIndex or all: true, or narrow the pattern with context.",
			"edit validates replacements and re-parses the file; a change that would break syntax is rejected without writing. delete removes only the matched node (include the trailing semicolon to delete a statement); insertBefore/insertAfter text must be valid standalone code.",
			"Use edit with oldText/newText for non-code files, tiny exact text swaps, or files whose language ast-grep does not support. Exact mode takes no structural argument: to insert around an exact anchor, rewrite the text (newText = <new code> + oldText to insert before, or oldText + <new code> to insert after) instead of reaching for insertBefore/insertAfter.",
		],
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments,
		execute,
	});
}
