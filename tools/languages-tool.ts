import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { callBinary } from "./binary.ts";

interface LanguagesBinaryResult {
	languages: Array<{ name: string; extensions: string[] }>;
}

async function execute() {
	const result = await callBinary<LanguagesBinaryResult>(["languages"]);
	const lines = [
		"ast-grep edits these file types structurally (other files fall back to exact text replacement):",
	];
	for (const lang of result.languages) {
		lines.push(`  ${lang.name}: ${lang.extensions.join(", ")}`);
	}
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {},
	};
}

export function registerLanguagesTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ast_languages",
		label: "ast_languages",
		description:
			"List the file types edited structurally by ast-grep. Files with other extensions are still editable via edit (exact text mode).",
		promptSnippet: "List languages supported by ast-grep editing",
		promptGuidelines: [
			"Use ast_languages to check whether a file type is edited structurally by ast-grep.",
		],
		parameters: Type.Object({}),
		execute,
	});
}
