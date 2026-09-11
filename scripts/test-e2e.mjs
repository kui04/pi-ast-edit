// E2E: drives real `pi` (only this extension, real model) against temp
// fixtures and asserts resulting file state. Config via scripts/.env
// (see .env.example); every .env entry is passed to pi's environment,
// so provider API keys go there too. Run: node scripts/test-e2e.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path) {
	if (!existsSync(path)) {
		console.error(
			`missing ${path}: copy scripts/.env.example to scripts/.env and set PI_E2E_MODEL`,
		);
		process.exit(1);
	}
	const env = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const i = t.indexOf("=");
		if (i < 0) continue;
		let v = t.slice(i + 1).trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
			v = v.slice(1, -1);
		env[t.slice(0, i).trim()] = v;
	}
	return env;
}

const fileEnv = loadEnv(join(repo, "scripts", ".env"));
const MODEL = fileEnv.PI_E2E_MODEL;
if (!MODEL) {
	console.error("PI_E2E_MODEL is empty: set it in scripts/.env (e.g. ollama-cloud/gemma4:31b)");
	process.exit(1);
}
const cfg = {
	piBin: fileEnv.PI_E2E_PI_BIN || "pi",
	thinking: fileEnv.PI_E2E_THINKING || null,
	timeoutMs: Number(fileEnv.PI_E2E_TIMEOUT_MS) || 600000,
	keep: fileEnv.PI_E2E_KEEP === "1",
	ext: join(repo, "index.ts"),
};

function runPi(cwd, prompt) {
	return new Promise((resolve) => {
		const args = ["-ne", "-e", cfg.ext, "--model", MODEL];
		if (cfg.thinking) args.push("--thinking", cfg.thinking);
		args.push("-p", prompt);
		// stdin must be ignore (/dev/null): an open pipe that never EOFs
		// makes pi wait on stdin forever with zero output.
		const child = spawn(cfg.piBin, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...fileEnv },
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const started = Date.now();
		const beat = setInterval(() => {
			console.log(`  ... still running (${Math.round((Date.now() - started) / 1000)}s elapsed)`);
		}, 60000);
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ code: -1, out: `${out}\n[TIMEOUT after ${cfg.timeoutMs}ms]` });
		}, cfg.timeoutMs);
		child.on("exit", (code) => {
			clearTimeout(timer);
			clearInterval(beat);
			resolve({ code: code ?? 1, out });
		});
	});
}

const results = [];
const check = (name, cond, detail) => {
	results.push([name, cond]);
	console.log(`${cond ? "ok" : "FAIL"} ${name}`);
	if (!cond && detail) console.log(detail);
};

// Each case: fresh temp fixture, one pi run, then assert file state.
const cases = [
	{
		name: "structural-rename",
		files: {
			"src/app.js":
				"function  computeTotal( a, b ) {\n\treturn a + b;\n}\n\nconst x = computeTotal(10, 20);\nconst y = computeTotal(1, 2);\n",
		},
		prompt:
			"把 src/app.js 里的函数 computeTotal 重命名为 computeSum，包括定义处和所有调用处。不要做其他任何改动，不要格式化其余代码，直接执行，不要询问确认。",
		verify: (dir) => {
			const got = readFileSync(join(dir, "src/app.js"), "utf8");
			const want =
				"function  computeSum( a, b ) {\n\treturn a + b;\n}\n\nconst x = computeSum(10, 20);\nconst y = computeSum(1, 2);\n";
			return got === want ? null : `content mismatch:\n--- want ---\n${want}\n--- got ---\n${got}`;
		},
	},
	{
		name: "exact-fallback-txt",
		files: { "notes.txt": "hello world\nsecond line\n" },
		prompt: "把 notes.txt 里的 world 改成 there。不要做其他任何改动，直接执行，不要询问确认。",
		verify: (dir) => {
			const got = readFileSync(join(dir, "notes.txt"), "utf8");
			return got === "hello there\nsecond line\n" ? null : `content mismatch, got:\n${got}`;
		},
	},
	{
		name: "delete-statement",
		files: { "src/app.js": "const a = 1;\ndebug(a);\nconst b = 2;\n" },
		prompt:
			"删除 src/app.js 里第 2 行的 debug(a); 整条语句（含分号）。不要做其他任何改动，直接执行，不要询问确认。",
		verify: (dir) => {
			// Intent oracle (not path-specific): the debug line is gone, the
			// other lines are byte-identical. A leftover blank line is
			// acceptable — it depends on whether the agent deleted via
			// pattern (node only) or exact text (line incl. newline).
			const got = readFileSync(join(dir, "src/app.js"), "utf8");
			const lines = got.split("\n");
			if (lines[0] !== "const a = 1;") return `first line changed, got:\n${got}`;
			if (lines[lines.length - 2] !== "const b = 2;") return `last code line changed, got:\n${got}`;
			const middle = lines.slice(1, -2);
			if (middle.some((l) => l.trim() !== "")) return `unexpected content left, got:\n${got}`;
			if (got.includes("debug")) return `debug call still present, got:\n${got}`;
			return null;
		},
	},
];

for (const c of cases) {
	const started = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "pi-ag-e2e-"));
	for (const [p, content] of Object.entries(c.files)) {
		mkdirSync(join(dir, dirname(p)), { recursive: true });
		writeFileSync(join(dir, p), content);
	}
	const r = await runPi(dir, c.prompt);
	const secs = Math.round((Date.now() - started) / 1000);
	if (r.code !== 0) {
		check(
			`${c.name} (${secs}s)`,
			false,
			`pi exit ${r.code}, fixture kept at ${dir}:\n${r.out.slice(-3000)}`,
		);
		continue;
	}
	const err = c.verify(dir);
	check(`${c.name} (${secs}s)`, err === null, err ? `${err}\nfixture kept at ${dir}` : "");
	if (err === null && !cfg.keep) rmSync(dir, { recursive: true, force: true });
	else console.log(`fixture kept at ${dir}`);
}

const failed = results.filter(([, ok]) => !ok);
console.log(`${results.length - failed.length}/${results.length} e2e cases passed`);
if (failed.length) process.exit(1);
