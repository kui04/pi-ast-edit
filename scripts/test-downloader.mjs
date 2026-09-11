// Tests for binary provisioning: tools/binary.ts resolves local builds and
// the postinstall cache (missing binary = background re-download + fallback),
// scripts/postinstall.mjs downloads the release asset at install time, and
// tools/edit-tool.ts falls back to pi's built-in editor without blocking.
// A local HTTP server fakes the release.
// Run: node scripts/test-downloader.mjs

import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const binary = [
	join(repo, "target", "release", "pi-ast-edit"),
	join(repo, "target", "debug", "pi-ast-edit"),
	join(repo, "result", "bin", "pi-ast-edit"),
].find((p) => existsSync(p));
if (!binary) {
	console.error("build the binary first: nix build (or nix develop -c cargo build)");
	process.exit(1);
}

let version = "v0.3.0";
let downloads = 0;
let failDownload = false;
let assetDelayMs = 0;
const server = createServer(async (req, res) => {
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
			if (assetDelayMs) await new Promise((r) => setTimeout(r, assetDelayMs));
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
mkdirSync(join(fakeExt, "scripts"), { recursive: true });
cpSync(join(repo, "tools", "binary.ts"), join(fakeExt, "tools", "binary.ts"));
cpSync(join(repo, "scripts", "provision.mjs"), join(fakeExt, "scripts", "provision.mjs"));

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
	cpSync(join(repo, "scripts", "provision.mjs"), join(clone, "scripts", "provision.mjs"));
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

	// 6. binary missing at runtime: edit warns, falls back to the built-in
	// editor without blocking, and self-heals via a background re-download.
	// The server delays the asset so a blocking implementation cannot pass
	// the "fast" assertion below.
	const home6 = mkdtempSync(join(tmpdir(), "pi-ag-dl6-"));
	const ext6 = mkdtempSync(join(tmpdir(), "pi-ag-ext6-"));
	const work6 = mkdtempSync(join(tmpdir(), "pi-ag-work6-"));
	mkdirSync(join(ext6, "tools"), { recursive: true });
	mkdirSync(join(ext6, "scripts"), { recursive: true });
	symlinkSync(join(repo, "node_modules"), join(ext6, "node_modules"), "dir");
	cpSync(join(repo, "tools", "edit-tool.ts"), join(ext6, "tools", "edit-tool.ts"));
	cpSync(join(repo, "tools", "binary.ts"), join(ext6, "tools", "binary.ts"));
	cpSync(join(repo, "scripts", "provision.mjs"), join(ext6, "scripts", "provision.mjs"));
	writeFileSync(
		join(ext6, "package.json"),
		JSON.stringify({ name: "x", repository: { url: "https://github.com/test/pi-ast-edit.git" } }),
	);
	writeFileSync(join(work6, "a.txt"), "hello foo world\n");
	const driver6 = join(home6, "driver6.mjs");
	writeFileSync(
		driver6,
		`import { readFileSync } from "node:fs";
import { join } from "node:path";
const ext = process.env.PI_AST_EDIT_EXT;
const { registerEditTool } = await import(join(ext, "tools", "edit-tool.ts"));
let def;
registerEditTool({ registerTool: (d) => { def = d; } });
const notices = [];
const ctx = {
  cwd: process.env.PI_AST_EDIT_WORK,
  hasUI: true,
  ui: { notify: (m, t) => notices.push(t + ":" + m) },
};
const t0 = Date.now();
const res = await def.execute("t1", { path: "a.txt", edits: [{ oldText: "foo", newText: "bar" }] }, undefined, undefined, ctx);
const elapsed = Date.now() - t0;
const text = res.content.map((c) => c.text ?? "").join("\\n");
console.log("edit-ok:" + (readFileSync(join(ctx.cwd, "a.txt"), "utf8") === "hello bar world\\n"));
console.log("notice:" + text.includes("built-in"));
console.log("warn:" + notices.some((n) => n.startsWith("warning:")));
console.log("fast:" + (elapsed < 1500));
let err = null;
try {
  await def.execute("t2", { path: "a.txt", edits: [{ pattern: "bar", replace: "baz" }] }, undefined, undefined, ctx);
} catch (e) { err = e; }
console.log("structural:" + (err !== null && err.message.includes("NOT applied")));
await new Promise((r) => setTimeout(r, 4500));
console.log("done");
`,
	);
	const dlBefore6 = downloads;
	assetDelayMs = 3000;
	r = await runScript(driver6, [], {
		HOME: home6,
		PI_AST_EDIT_EXT: ext6,
		PI_AST_EDIT_WORK: work6,
	});
	assetDelayMs = 0;
	check(
		"fallback edit succeeds via built-in editor",
		r.code === 0 && r.out.includes("edit-ok:true") && r.out.includes("notice:true"),
	);
	check("fallback warns the user", r.code === 0 && r.out.includes("warn:true"));
	check("fallback does not block on the download", r.out.includes("fast:true"));
	check("structural edit reports binary missing", r.out.includes("structural:true"));
	check("background re-download self-heals", downloads === dlBefore6 + 1);

	rmSync(home2, { recursive: true, force: true });
	rmSync(home3, { recursive: true, force: true });
	rmSync(clone, { recursive: true, force: true });
	rmSync(clone2, { recursive: true, force: true });
	rmSync(home6, { recursive: true, force: true });
	rmSync(ext6, { recursive: true, force: true });
	rmSync(work6, { recursive: true, force: true });
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
