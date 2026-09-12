import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheBinaryPath, configuredRepo, downloadToCache } from "../scripts/provision.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../tools
const EXT_DIR = dirname(HERE); // extension root (repo root)

// The binary is provisioned at install time by scripts/postinstall.mjs
// (pi runs `npm install` for git packages, which executes postinstall).
// postinstall downloads into ~/.pi/agent/cache/pi-ast-edit/<triple>/<asset>;
// resolution here checks local builds first, then that cache. A missing
// binary never blocks a tool call: the edit tool immediately falls back to
// pi's built-in exact-text editor, and a background re-download is started
// (deduped, cooled down) so a later call finds the cache repopulated.
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
		// Local dev builds first: debug (`cargo test`/`cargo build`), then the
		// nix flake's `result/bin` (also a local, deliberately-built artifact),
		// then an explicit release build — all fresher candidates than the
		// postinstall download from a GitHub release.
		candidates.push(join(base, "target", "debug", "pi-ast-edit"));
		candidates.push(join(base, "result", "bin", "pi-ast-edit"));
		candidates.push(join(base, "target", "release", "pi-ast-edit"));
	}
	const cached = cacheBinaryPath();
	if (cached) candidates.push(cached);
	return candidates;
}

export function findBinary(): string | null {
	for (const c of candidatePaths()) {
		if (existsSync(c)) return c;
	}
	return null;
}

let redownloadPromise: Promise<string | null> | null = null;
let lastRedownloadAttempt = 0;
const REDOWNLOAD_COOLDOWN_MS = 60_000;

/**
 * Fire-and-forget self-heal: kick off one background re-download when the
 * binary is missing, so a later call finds the cache repopulated. Never
 * blocks the caller; deduped while in flight and cooled down between
 * attempts so a broken/offline download is not retried on every call.
 */
export function redownloadInBackground(): void {
	if (redownloadPromise) return;
	const now = Date.now();
	if (now - lastRedownloadAttempt < REDOWNLOAD_COOLDOWN_MS) return;
	const repo = configuredRepo(EXT_DIR);
	if (!repo) return;
	lastRedownloadAttempt = now;
	redownloadPromise = downloadToCache(repo)
		.catch(() => null)
		.finally(() => {
			redownloadPromise = null;
		});
}

export const BINARY_HINT = [
	"pi-ast-edit binary not found.",
	"Install the extension (npm install runs postinstall, which downloads it),",
	"or build it in the extension repo:",
	"  nix build            # or: nix develop -c cargo build --release",
	"or set PI_AST_EDIT_BIN to the binary path.",
	"A background re-download was started; the edit tool falls back to pi's",
	"built-in exact-text edit in the meantime.",
].join("\n");

export async function runBinary(
	args: string[],
	input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const bin = findBinary();
	if (!bin) {
		redownloadInBackground();
		throw new Error(BINARY_HINT);
	}
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
