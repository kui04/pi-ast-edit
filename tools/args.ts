/**
 * Empty-sentinel pruning for tool arguments.
 *
 * Some models (and strict JSON-schema sampling) fill every optional field of a
 * tool schema, encoding "unused" as `""` / `false` / `null`. The binary treats
 * *key presence* as intent, so `pattern: ""` next to a real `oldText` reads as
 * "both modes provided" and `context: ""` fails to parse as an ast-grep
 * pattern. Normalize once, before validation (pi's `prepareArguments` hook).
 */
export interface SentinelRules {
	/** Keys where `""` means "not provided" (`null`/`undefined` always is). */
	emptyStrings: readonly string[];
	/** Keys where `false` means "not provided". */
	falseBooleans?: readonly string[];
}

/** Drop `null`/`undefined`, the listed empty strings, and the listed `false` values. */
export function pruneSentinels(
	input: Record<string, unknown>,
	rules: SentinelRules,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value === null || value === undefined) continue;
		if (value === "" && rules.emptyStrings.includes(key)) continue;
		if (value === false && rules.falseBooleans?.includes(key)) continue;
		out[key] = value;
	}
	return out;
}
