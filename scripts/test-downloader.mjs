// Tests for binary provisioning: tools/binary.ts resolves local builds only
// (missing binary = loud error), scripts/postinstall.mjs downloads the
// release asset at install time. A local HTTP server fakes the release.
// Run: node scripts/test-downloader.mjs

import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const binary =
	(existsSync(join(repo, "target", "release", "pi-ast-edit")) &&
		join(repo, "target", "release", "pi-ast-edit")) ||
	(existsSync(join(repo, "target", "debug", "pi-ast-edit")) &&
		join(repo, "target", "debug", "pi-ast-edit"));
if (!binary) {
	console.error("build the binary first: nix develop -c cargo build");
	process.exit(1);
}

let version = "v0.3.0";
let downloads = 0;
let failDownload = false;
const server = createServer((req, res) => {
	const url = req.url ?? "";
	const api = url.match(/^\/repos\/(.+)\/releases\/latest$/);
	const dl = url.match(/^\/(.+)\/releases\/latest\/download\/([A-Za-z0-9_.-]+)$/);
	if (api) {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ tag_name: version }));
	} else if (dl) {
		if (failDownload) {
			res.statusCode = 500;
			res.end("boom");
		} else {
			downloads++;
			res.end(readFileSync(binary));
		}
	} else {
		res.statusCode = 404;
		res.end(`not found: ${url}`);
	}
});

const results = [];
const check = (name, cond) => {
	results.push([name, cond]);
	if (!cond) console.error(`FAIL: ${name}`);
};

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const home = mkdtempSync(join(tmpdir(), "pi-ag-dl-"));
const fakeExt = mkdtempSync(join(tmpdir(), "pi-ag-ext-"));
mkdirSync(join(fakeExt, "tools"), { recursive: true });
cpSync(join(repo, "tools", "binary.ts"), join(fakeExt, "tools", "binary.ts"));

// Run an arbitrary script, resolving (not rejecting) with exit code + output.
const runScript = (script, args = [], extraEnv = {}) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, [script, ...args], {
			env: {
				...process.env,
				PI_AST_EDIT_BASE_URL: base,
				PI_AST_EDIT_BIN: "",
				HOME: home,
				...extraEnv,
			},
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("exit", (code) => resolve({ code, out }));
	});

const cacheOf = (h) => join(h, ".pi", "agent", "cache", "pi-ast-edit");

// A fake installed package: postinstall.mjs + package.json, no local build.
const makeClone = (pkgJson) => {
	const clone = mkdtempSync(join(tmpdir(), "pi-ag-clone-"));
	mkdirSync(join(clone, "scripts"), { recursive: true });
	cpSync(join(repo, "scripts", "postinstall.mjs"), join(clone, "scripts", "postinstall.mjs"));
	writeFileSync(join(clone, "package.json"), JSON.stringify(pkgJson));
	return clone;
};

const missingDriver = join(home, "missing.mjs");
writeFileSync(
	missingDriver,
	`import { join } from "node:path";
const mod = await import(join(process.env.PI_AST_EDIT_EXT, "tools", "binary.ts"));
let err = null;
try { await mod.callBinary(["languages"]); } catch (e) { err = e; }
if (!err || !err.message.includes("binary not found")) throw new Error("expected BINARY_HINT, got: " + err);
console.log("missing-binary ok");
`,
);

try {
	// 1. no local binary anywhere: loud error, no silent download
	let r = await runScript(missingDriver, [], { PI_AST_EDIT_EXT: fakeExt });
	check("missing binary fails loudly", r.code === 0 && r.out.includes("missing-binary ok"));

	// 2. postinstall pre-warms a cold cache, resolving the repo from package.json
	const home2 = mkdtempSync(join(tmpdir(), "pi-ag-dl2-"));
	const clone = makeClone({
		name: "x",
		repository: { url: "https://github.com/test/pi-ast-edit.git" },
	});
	const dlBefore = downloads;
	r = await runScript(join(clone, "scripts", "postinstall.mjs"), [], {
		HOME: home2,
		PI_AST_EDIT_REPO: "",
	});
	check("postinstall exits 0", r.code === 0);
	check("postinstall downloads on cold cache", downloads === dlBefore + 1);
	check(
		"postinstall writes version",
		readFileSync(join(cacheOf(home2), "version"), "utf8").trim() === version,
	);
	r = await runScript(join(clone, "scripts", "postinstall.mjs"), [], {
		HOME: home2,
		PI_AST_EDIT_REPO: "",
	});
	check("postinstall idempotent when current", r.code === 0 && downloads === dlBefore + 1);

	// 3. postinstall with no repo anywhere: warn, exit 0 (dev `npm install` path)
	const home3 = mkdtempSync(join(tmpdir(), "pi-ag-dl3-"));
	const clone2 = makeClone({ name: "x" });
	r = await runScript(join(clone2, "scripts", "postinstall.mjs"), [], {
		HOME: home3,
		PI_AST_EDIT_REPO: "",
	});
	check(
		"postinstall no-repo warns but exits 0",
		r.code === 0 && r.out.includes("PI_AST_EDIT_REPO"),
	);

	// 4. postinstall fails loudly on real download errors
	version = "v0.4.0";
	failDownload = true;
	r = await runScript(join(clone, "scripts", "postinstall.mjs"), [], {
		HOME: home2,
		PI_AST_EDIT_REPO: "",
	});
	failDownload = false;
	check("postinstall fails loudly on HTTP error", r.code !== 0 && r.out.includes("FAILED"));

	// 5. postinstall skips when a local build exists (real repo has target/)
	r = await runScript(join(repo, "scripts", "postinstall.mjs"), [], { PI_AST_EDIT_REPO: "" });
	check("postinstall skips on local build", r.code === 0 && r.out.includes("local build"));

	rmSync(home2, { recursive: true, force: true });
	rmSync(home3, { recursive: true, force: true });
	rmSync(clone, { recursive: true, force: true });
	rmSync(clone2, { recursive: true, force: true });
} finally {
	server.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(fakeExt, { recursive: true, force: true });
}

const failed = results.filter(([, ok]) => !ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
	for (const [name] of failed) console.error(`  FAIL: ${name}`);
	process.exit(1);
}
