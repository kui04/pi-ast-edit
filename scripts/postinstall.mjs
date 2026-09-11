// postinstall: pre-warm the pi-ast-edit binary cache at install time, so the
// extension works immediately after `pi install`.
// Plain JS (node >= 18). Exit 0 = ready or safely skipped; exit 1 = real
// failure with a clear message.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "pi-ast-edit");
const VERSION_FILE = join(CACHE_DIR, "version");
const BASE_URL = process.env.PI_AST_EDIT_BASE_URL ?? null;
const DL_ROOT = BASE_URL ?? "https://github.com";
const API_ROOT = BASE_URL ? `${BASE_URL}/repos` : "https://api.github.com/repos";

const log = (m) => console.log(`pi-ast-edit postinstall: ${m}`);
const fail = (m) => {
	console.error(`pi-ast-edit postinstall FAILED: ${m}`);
	process.exit(1);
};

/** Normalize `git:github.com/a/b`, `https://github.com/a/b.git` → `a/b`. */
function normalizeRepo(s) {
	const m = s.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
	return m ? m[1] : s;
}

function configuredRepo() {
	const fromEnv = process.env.PI_AST_EDIT_REPO ?? "";
	if (fromEnv) return normalizeRepo(fromEnv);
	try {
		const pkg = JSON.parse(readFileSync(join(EXT_ROOT, "package.json"), "utf8"));
		return normalizeRepo(pkg.repository?.url ?? "");
	} catch {
		return "";
	}
}

function assetTriple() {
	const platform =
		process.platform === "linux"
			? "linux"
			: process.platform === "darwin"
				? "darwin"
				: process.platform === "win32"
					? "win32"
					: null;
	const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
	if (!platform || !arch) {
		fail(
			`unsupported platform ${process.platform}/${process.arch} — set PI_AST_EDIT_BIN or build from source (nix build).`,
		);
	}
	return `pi-ast-edit-${platform}-${arch}`;
}

/** Release asset file name; Windows needs the .exe suffix to run. */
function assetName() {
	const triple = assetTriple();
	return process.platform === "win32" ? `${triple}.exe` : triple;
}

function localBuild() {
	if (process.env.PI_AST_EDIT_BIN && existsSync(process.env.PI_AST_EDIT_BIN)) {
		return process.env.PI_AST_EDIT_BIN;
	}
	const roots = [EXT_ROOT];
	try {
		roots.push(realpathSync(EXT_ROOT));
	} catch {
		// dangling or odd path — ignore
	}
	const exe = process.platform === "win32" ? ".exe" : "";
	for (const base of roots) {
		for (const p of [
			`target/release/pi-ast-edit${exe}`,
			`target/debug/pi-ast-edit${exe}`,
			`result/bin/pi-ast-edit${exe}`,
		]) {
			const full = join(base, p);
			if (existsSync(full)) return full;
		}
	}
	return null;
}

function readVersion() {
	try {
		return readFileSync(VERSION_FILE, "utf8").trim();
	} catch {
		return "";
	}
}

/** Latest release tag, or null when nothing is published yet. */
async function latestTag(repo) {
	const res = await fetch(`${API_ROOT}/${repo}/releases/latest`, {
		headers: { "User-Agent": "pi-ast-edit" },
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`release metadata request failed: HTTP ${res.status}`);
	return (await res.json()).tag_name ?? null;
}

/** Download the asset; false when not published (yet). Throws on real errors. */
async function download(bin, repo) {
	const asset = assetName();
	const url = `${DL_ROOT}/${repo}/releases/latest/download/${asset}`;
	const res = await fetch(url);
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${url}`);
	const tmp = `${bin}.tmp-${process.pid}`;
	mkdirSync(dirname(bin), { recursive: true });
	try {
		writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
		chmodSync(tmp, 0o755);
		const check = spawnSync(tmp, ["languages"], { timeout: 15000 });
		if (check.error || check.status !== 0) {
			throw new Error(
				`downloaded binary failed its sanity check (${check.error?.message ?? `exit ${check.status}`}) — is the ${asset} release asset valid?`,
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
	return true;
}

async function main() {
	const local = localBuild();
	if (local) {
		log(`using local build at ${local}, skip download`);
		return;
	}
	const repo = configuredRepo();
	if (!repo) {
		log(
			"WARNING: no repo configured (set PI_AST_EDIT_REPO=owner/repo or add package.json repository); binary will download on first use",
		);
		return;
	}
	const bin = join(CACHE_DIR, assetTriple(), assetName());
	const cached = existsSync(bin);
	const version = readVersion();
	let latest;
	try {
		latest = await latestTag(repo);
	} catch (err) {
		if (cached) {
			log(`WARNING: ${err.message}; keeping cached binary`);
			return;
		}
		fail(`${err.message}. Set PI_AST_EDIT_BIN, build from source (nix build), or retry online.`);
	}
	if (latest === null) {
		if (!cached) {
			log(
				`WARNING: no GitHub release published for ${repo} yet; binary will download on first use`,
			);
		}
		return;
	}
	if (cached && latest === version) {
		log(`binary already current (${latest})`);
		return;
	}
	let ok;
	try {
		ok = await download(bin, repo);
	} catch (err) {
		fail(`${err.message}. Set PI_AST_EDIT_BIN, build from source (nix build), or retry online.`);
	}
	if (!ok) {
		log(`WARNING: ${assetName()} not in the latest release; binary will download on first use`);
		return;
	}
	mkdirSync(dirname(VERSION_FILE), { recursive: true });
	writeFileSync(VERSION_FILE, latest);
	log(`binary ready (${latest})`);
}

await main();
