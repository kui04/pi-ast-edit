# AGENTS.md

## Project overview

pi extension: replaces the built-in `edit` tool with ast-grep structural matching, plus
`ast_find` / `ast_languages`. `src/` = Rust binary (JSON over stdin/stdout, ast-grep-core 0.45.3);
`index.ts` + `tools/` = pi extension (TypeScript). Behavior, safety model, install, telemetry:
see README.md.

## Environment & commands

Dev environment is the nix flake — run everything through `nix develop`:

```bash
nix develop -c npm install          # dev deps (once)
nix develop -c cargo test           # unit + integration tests
nix develop -c cargo clippy --all-targets -- -D warnings
nix develop -c cargo fmt --check
nix develop -c npx tsc --noEmit
nix develop -c npx @biomejs/biome ci --error-on-warnings .
nix develop -c npm run test:ts  # TS unit + integration + binary downloader
nix build                           # binary → result/bin/pi-ast-edit
```

Format before committing: `cargo fmt` / `biome check --write .` (same `nix develop -c` prefix).
Commit through the shell — `nix develop -c git commit` — pre-commit hooks need the shell's
toolchain; never `--no-verify`. CI checks (`checks.yml`) mirror these commands; keep in sync.

## Conventions

- Don't weaken the edit tool's safety model: replacement validated standalone, whole file
  re-parsed and rolled back on new syntax errors, ambiguous patterns rejected (matchIndex/all),
  undefined `$VAR` rejected.
- Keep `ast-grep-core` and `ast-grep-language` in lockstep (0.45.3).
- Binary resolution: `PI_AST_EDIT_BIN` → `target/debug` → `result/bin` (nix build)
  → `target/release` → postinstall cache — local builds first, download last.
  Missing: `edit` falls back to pi's builtin; `ast_find`/`ast_languages` fail fast.
- Release: tag push → `release.yml` builds 6 platform binaries; `checks.yml` runs as gate.
- Telemetry & reflection: passive turn-end reflection (on by default; input = failed `edit` tool results on the session branch; verdict queued as an `ast-edit.reflection` custom message) + opt-in developer JSONL trace (`agentDir/ast-edit.log.jsonl`) — never throw, stay compact (no file contents).