// Shared binary provisioning for scripts/postinstall.mjs (install time) and
// tools/binary.ts (runtime fallback when the cache is missing).
// Plain JS (node >= 18) so postinstall can run it on any supported node;
// binary.ts imports it via node's ESM interop.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "pi-ast-edit");
export const VERSION_FILE = join(CACHE_DIR, "version");

const BASE_URL = process.env.PI_AST_EDIT_BASE_URL ?? null;
export const DL_ROOT = BASE_URL ?? "https://github.com";
export const API_ROOT = BASE_URL ? `${BASE_URL}/repos` : "https://api.github.com/repos";

/** Asset triple, e.g. `pi-ast-edit-linux-x64`; null on unsupported platforms. */
export function assetTriple() {
	const platform =
		process.platform === "linux"
			? "linux"
			: process.platform === "darwin"
				? "darwin"
				: process.platform === "win32"
					? "win32"
					: null;
	const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
	if (!platform || !arch) return null;
	return `pi-ast-edit-${platform}-${arch}`;
}

/** Release asset file name; Windows needs the .exe suffix to run. */
export function assetName() {
	const triple = assetTriple();
	if (!triple) return null;
	return process.platform === "win32" ? `${triple}.exe` : triple;
}

/** Full path the binary is cached at, or null on unsupported platforms. */
export function cacheBinaryPath() {
	const triple = assetTriple();
	const name = assetName();
	if (!triple || !name) return null;
	return join(CACHE_DIR, triple, name);
}

export function readVersion() {
	try {
		return readFileSync(VERSION_FILE, "utf8").trim();
	} catch {
		return "";
	}
}

/** Normalize `git:github.com/a/b`, `https://github.com/a/b.git` → `a/b`. */
export function normalizeRepo(s) {
	const m = s.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
	return m ? m[1] : s;
}

/** Resolve the release repo from PI_AST_EDIT_REPO or package.json repository. */
export function configuredRepo(extRoot) {
	const fromEnv = process.env.PI_AST_EDIT_REPO ?? "";
	if (fromEnv) return normalizeRepo(fromEnv);
	try {
		const pkg = JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8"));
		return normalizeRepo(pkg.repository?.url ?? "");
	} catch {
		return "";
	}
}

/** Latest release tag, or null when nothing is published yet. */
export async function latestTag(repo) {
	const res = await fetch(`${API_ROOT}/${repo}/releases/latest`, {
		headers: { "User-Agent": "pi-ast-edit" },
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`release metadata request failed: HTTP ${res.status}`);
	return (await res.json()).tag_name ?? null;
}

/**
 * Download the asset into the cache and record the version.
 * Returns the binary path, or null when the asset is not published (yet).
 * Throws on real errors. `tag` is the version to record; when omitted it is
 * fetched (an extra API call).
 */
export async function downloadToCache(repo, tag) {
	const bin = cacheBinaryPath();
	const name = assetName();
	if (!bin || !name) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
	const url = `${DL_ROOT}/${repo}/releases/latest/download/${name}`;
	const res = await fetch(url);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${url}`);
	const tmp = `${bin}.tmp-${process.pid}`;
	mkdirSync(dirname(bin), { recursive: true });
	try {
		writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
		chmodSync(tmp, 0o755);
		const check = spawnSync(tmp, ["languages"], { timeout: 15000 });
		if (check.error || check.status !== 0) {
			throw new Error(
				`downloaded binary failed its sanity check (${check.error?.message ?? `exit ${check.status}`}) — is the ${name} release asset valid?`,
			);
		}
		renameSync(tmp, bin);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// already gone
		}
		throw err;
	}
	const recorded = tag ?? (await latestTag(repo)) ?? "";
	mkdirSync(dirname(VERSION_FILE), { recursive: true });
	writeFileSync(VERSION_FILE, recorded);
	return bin;
}

/** True when a cached binary already exists (regardless of version). */
export function hasCachedBinary() {
	return existsSync(cacheBinaryPath());
}
