# AGENTS.md

## Project overview

A [pi](https://github.com/earendil-works/pi) extension that replaces the built-in `edit` tool
with an ast-grep–powered one (plus `ast_find` / `ast_languages` helpers). Two parts:

- `src/` — Rust binary (`edit`, `find`, `languages` commands), JSON over stdin/stdout,
  ast-grep-core 0.45.3 + tree-sitter grammars compiled in
- `index.ts` + `tools/` — pi extension (TypeScript, loaded via jiti)

See README.md for the extension's behavior, safety model, and install flow — do not duplicate
that prose here.

## Dev environment

```bash
nix develop     # rust toolchain (rust-overlay) + nodejs + gcc
npm install     # dev deps for typechecking the extension
nix build       # binary at result/bin/pi-ast-edit
```

Pre-commit hooks (clippy, rustfmt, biome, actionlint) are installed by git-hooks.nix inside
`nix develop`. Run all of them once manually: `nix fmt`. Outside nix, the Rust toolchain
comes from `rust-toolchain.toml` (stable, clippy component).

## Verify (must stay in sync with `.github/workflows/checks.yml`)

```bash
cargo test                                  # unit + integration tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
npx tsc --noEmit                            # typecheck the extension
npx @biomejs/biome ci --error-on-warnings . # lint TS/JS/JSON
node scripts/test-downloader.mjs            # binary downloader test
```

Auto-format with `cargo fmt` and `npx @biomejs/biome check --write .` before committing.
`checks.yml` is the single source of truth for CI — don't duplicate its steps in new workflows.

## E2E tests (slow, need a real model)

```bash
cp scripts/.env.example scripts/.env   # then set PI_E2E_MODEL
node scripts/test-e2e.mjs
```

Drives real `pi` through 3 journeys (several minutes). `scripts/.env` entries are passed into
pi's environment, so provider API keys (`OPENAI_API_KEY`, ...) belong there too.

## Conventions

- Don't weaken the edit tool's safety model (replacement parse validation, whole-file reparse +
  rollback, uniqueness guard, undefined-`$VAR` rejection) — it is the extension's contract.
- Keep `ast-grep-core` and `ast-grep-language` versions in lockstep (both 0.45.3) — language
  files and core must match.
- Binary resolution order: `PI_AST_EDIT_BIN` env var → `target/release` → `target/debug` →
  `result/bin` → postinstall cache in `~/.pi/agent/cache/pi-ast-edit/`. When missing, `edit`
  warns and falls back to pi's built-in editor; `ast_find`/`ast_languages` fail fast.
- Release: tag push (`git tag vX.Y.Z && git push origin vX.Y.Z`) → `release.yml` builds
  musl-static linux x64/arm64, darwin x64/arm64, win32 x64 and attaches them to the GitHub
  release; `checks.yml` runs as a publish gate.

## Edit-tool telemetry

Every `edit` call is optionally recorded as a per-session custom entry
(pi.appendEntry, customType `piAstEditTrace` — session-scoped, not sent to
LLM). Config: `piAstEdit` key in `~/.pi/agent/settings.json` (pi preserves
unknown settings keys): `traceEnabled` (default false) and `insightsLines`
(default 300). `recordEditTrace` in tools/insights.ts never throws —
telemetry must not break an edit; records stay compact (mode, truncated
pattern, counts, error) with no file contents.

`/ast-edit-insights [N|all]` reads the current session's recorded entries
and sends a digest to the session model for clustering + concrete fix
proposals (guideline wording, schema changes, src/ bugs). Keep records
compact and structured — the command stringifies them as-is.

Headless dev tracing of the Rust binary stays env-driven:
`PI_AST_EDIT_TRACE` (+ `PI_AST_EDIT_TRACE_LEVEL`) enables the JSON-lines
layer in src/main.rs; debug events live in src/edit.rs. Unwritable paths
degrade to sink.