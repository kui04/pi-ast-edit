import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../tools
const EXT_DIR = dirname(HERE); // extension root (repo root)

// The binary is provisioned at install time by scripts/postinstall.mjs
// (pi runs `npm install` for git packages, which executes postinstall).
// Resolution here is local-only; a missing binary is a loud error, not a
// silent download: install-time is the correct moment to fetch it.
function realpathSafe(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

function candidatePaths(): string[] {
	const candidates: string[] = [];
	if (process.env.PI_AST_EDIT_BIN) candidates.push(process.env.PI_AST_EDIT_BIN);
	for (const base of [EXT_DIR, realpathSafe(EXT_DIR)]) {
		if (!base) continue;
		candidates.push(join(base, "target", "release", "pi-ast-edit"));
		candidates.push(join(base, "target", "debug", "pi-ast-edit"));
		candidates.push(join(base, "result", "bin", "pi-ast-edit"));
	}
	return candidates;
}

export function findBinary(): string | null {
	for (const c of candidatePaths()) {
		if (existsSync(c)) return c;
	}
	return null;
}

export const BINARY_HINT = [
	"pi-ast-edit binary not found.",
	"It is downloaded during `npm install` (postinstall) — re-run installation,",
	"or build it in the extension repo:",
	"  nix build            # or: nix develop -c cargo build --release",
	"or set PI_AST_EDIT_BIN to the binary path.",
].join("\n");

export async function runBinary(
	args: string[],
	input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const bin = findBinary();
	if (!bin) throw new Error(BINARY_HINT);
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("error", (err) => reject(new Error(`failed to run ${bin}: ${err.message}`)));
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
		if (input !== undefined) child.stdin.write(input);
		child.stdin.end();
	});
}

/** Run the binary and parse its JSON output; throws on non-zero exit or `{error}`. */
export async function callBinary<T>(args: string[], input?: string): Promise<T> {
	const { stdout, stderr, code } = await runBinary(args, input);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(
			`pi-ast-edit returned invalid JSON (exit ${code}): ${stderr || stdout.slice(0, 500)}`,
		);
	}
	const obj = parsed as { error?: string };
	if (code !== 0 || typeof obj.error === "string") {
		throw new Error(obj.error || `pi-ast-edit failed (exit ${code})`);
	}
	return parsed as T;
}
