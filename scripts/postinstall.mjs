// postinstall: pre-warm the pi-ast-edit binary cache at install time, so the
// extension works immediately after `pi install`.
// Plain JS (node >= 18). Exit 0 = ready or safely skipped; exit 1 = real
// failure with a clear message.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assetName,
	cacheBinaryPath,
	configuredRepo,
	downloadToCache,
	latestTag,
	readVersion,
} from "./provision.mjs";

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function log(msg) {
	console.log(`postinstall: ${msg}`);
}

function fail(msg) {
	console.error(`pi-ast-edit postinstall FAILED: ${msg}`);
	process.exit(1);
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

async function main() {
	const local = localBuild();
	if (local) {
		log(`using local build at ${local}, skip download`);
		return;
	}
	const repo = configuredRepo(EXT_ROOT);
	if (!repo) {
		log(
			"WARNING: no repo configured (set PI_AST_EDIT_REPO=owner/repo or add package.json repository); binary will download on first use",
		);
		return;
	}
	const bin = cacheBinaryPath();
	if (!bin) {
		fail(
			`unsupported platform ${process.platform}/${process.arch} — set PI_AST_EDIT_BIN or build from source (nix build).`,
		);
		return;
	}
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
		ok = await downloadToCache(repo, latest);
	} catch (err) {
		fail(`${err.message}. Set PI_AST_EDIT_BIN, build from source (nix build), or retry online.`);
	}
	if (!ok) {
		log(`WARNING: ${assetName()} not in the latest release; binary will download on first use`);
		return;
	}
	log(`binary ready (${latest})`);
}

await main();
