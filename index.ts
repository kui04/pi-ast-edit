import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "./tools/edit-tool.ts";
import { registerFindTool } from "./tools/find-tool.ts";
import { initInsights } from "./tools/insights.ts";
import { registerLanguagesTool } from "./tools/languages-tool.ts";

/**
 * pi-ast-edit: routes all file edits through ast-grep (AST-aware structural
 * matching) for the 28 supported languages, with exact-text fallback for
 * everything else.
 */
export default function (pi: ExtensionAPI) {
	initInsights(pi);
	registerEditTool(pi);
	registerFindTool(pi);
	registerLanguagesTool(pi);
}
