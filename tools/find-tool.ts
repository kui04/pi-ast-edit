import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { pruneSentinels, type SentinelRules } from "./args.ts";
import { callBinary } from "./binary.ts";

const findSchema = Type.Object({
	path: Type.String({ description: "Path to the file to search (relative or absolute)" }),
	pattern: Type.Optional(
		Type.String({
			description:
				'ast-grep pattern, e.g. "foo($A)". Whitespace-insensitive; $A captures one node, $$$A captures zero or more. Variable names must be UPPERCASE.',
		}),
	),
	context: Type.Optional(
		Type.String({ description: "Only report matches inside a match of this pattern." }),
	),
	kind: Type.Optional(
		Type.String({
			description:
				'Node kind to find, e.g. "function_declaration", "call_expression", "identifier".',
		}),
	),
	position: Type.Optional(
		Type.String({
			description:
				'"line:col" (1-based) — report the AST node at this position and its ancestors instead of pattern search.',
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max matches to report (default 20)." })),
});

interface FindBinaryResult {
	language: string;
	matches: Array<{
		line: number;
		col: number;
		endLine: number;
		endCol: number;
		kind: string;
		text: string;
		vars: Array<{ name: string; text: string }>;
		lineText: string;
	}>;
	node?: { kind: string; line: number; col: number; endLine: number; endCol: number; text: string };
	ancestors?: Array<{ kind: string; line: number; col: number; endLine: number; endCol: number }>;
	errors: Array<{ line: number; col: number; text: string }>;
}

function formatResult(result: FindBinaryResult, path: string, position?: string): string {
	const lines: string[] = [];
	if (result.node) {
		lines.push(`Node at ${position} in ${path} (${result.language}):`);
		lines.push(
			`  ${result.node.kind} (${result.node.line}:${result.node.col}-${result.node.endLine}:${result.node.endCol}): ${result.node.text}`,
		);
		if (result.ancestors && result.ancestors.length > 0) {
			lines.push("  ancestors:");
			for (const a of result.ancestors) {
				lines.push(`    ${a.kind} (${a.line}:${a.col}-${a.endLine}:${a.endCol})`);
			}
		}
	} else {
		lines.push(`Found ${result.matches.length} match(es) in ${path} (${result.language}):`);
		result.matches.forEach((m, i) => {
			const vars =
				m.vars.length > 0
					? `  [${m.vars.map((v) => `${v.name} = ${JSON.stringify(v.text)}`).join(", ")}]`
					: "";
			lines.push(`  ${i}. line ${m.line}, col ${m.col} (${m.kind}): ${m.text}${vars}`);
			lines.push(`     ${m.lineText}`);
		});
	}
	if (result.errors.length > 0) {
		lines.push(
			`Note: file has ${result.errors.length} syntax error(s) (first: line ${result.errors[0].line}: ${result.errors[0].text})`,
		);
	}
	return lines.join("\n");
}

async function execute(
	_toolCallId: string,
	params: FindInput,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const rawPath = params.path;
	const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const absolutePath = resolve(ctx.cwd, path);

	const args = ["find", "--path", absolutePath];
	if (params.pattern !== undefined) args.push("--pattern", params.pattern);
	if (params.context !== undefined) args.push("--context", params.context);
	if (params.kind !== undefined) args.push("--kind", params.kind);
	if (params.position !== undefined) args.push("--position", params.position);
	if (params.limit !== undefined) args.push("--limit", String(params.limit));

	const result = await callBinary<FindBinaryResult>(args);
	return {
		content: [{ type: "text" as const, text: formatResult(result, path, params.position) }],
		details: {},
	};
}

/** Schema-derived tool input, shared by `prepareArguments` and `execute`. */
type FindInput = Static<typeof findSchema>;

/** Optional ast_find fields where `""` means "not provided". */
const FIND_SENTINELS: SentinelRules = {
	emptyStrings: ["pattern", "context", "kind", "position"],
};

/** Drop the empty sentinels models send for unused options (see tools/args.ts). */
function prepareArguments(args: unknown): FindInput {
	if (!args || typeof args !== "object") return args as FindInput;
	return pruneSentinels(args as Record<string, unknown>, FIND_SENTINELS) as FindInput;
}

export function registerFindTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ast_find",
		label: "ast_find",
		description: [
			"Find code structurally in a file using ast-grep.",
			"pattern: ast-grep pattern (whitespace-insensitive; $A captures one node, $$$A zero or more).",
			"kind: node kind name (e.g. function_declaration, call_expression, identifier).",
			'position: "line:col" to inspect the AST node at a location and its ancestors.',
			"context: only matches inside a match of this pattern.",
			"Returns matches with line/col, node kind, text, captured variables, and the containing line — listed in order, which is edit's matchIndex order.",
			"Use it to locate code precisely and to check what a pattern matches before using it in edit.",
		].join("\n"),
		promptSnippet: "Find code by AST pattern, node kind, or position",
		promptGuidelines: [
			"Use ast_find to preview what a pattern matches before using it in edit — matches are listed in order, which is edit's matchIndex order.",
			"Use ast_find with position to discover the AST node kind at a location (and its ancestors) when writing kind patterns or debugging a pattern that matches nothing.",
		],
		parameters: findSchema,
		prepareArguments,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		execute,
	});
}
