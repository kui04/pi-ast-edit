# pi-ast-edit

**[中文 (Chinese)](README.zh-CN.md)**

A [pi](https://github.com/earendil-works/pi) extension extension that routes **all file
edits through [ast-grep](https://github.com/ast-grep/ast-grep)** — AST-aware
structural matching for 28 languages, with exact-text fallback. It replaces
the built-in `edit` tool and adds two helpers: `ast_find` (structural search)
and `ast_languages` (supported file types).

## Why

Exact-text matching fails when the model's memory of whitespace is off, and
can hit the *wrong* occurrence — partial tokens or text inside strings and
comments. ast-grep matches **whole AST nodes**: whitespace-insensitive, and
every replacement is validated — a change that would break syntax is
**rejected without writing**, and the whole file is re-parsed after editing
(rolled back on new syntax errors). Ambiguous patterns are rejected with the
full match list; add `matchIndex` or `all: true`, or narrow the pattern.

## Install

```bash
pi install git:github.com/kui04/pi-ast-edit
# or try without installing: pi -e git:github.com/kui04/pi-ast-edit
```

Local development: `nix build` (or `nix develop -c cargo build --release`),
then `pi -e ./index.ts`. The binary is located via `PI_AST_EDIT_BIN`, local
builds, or the postinstall download cache. If it's missing, `edit` warns once,
falls back to pi's built-in editor, and re-downloads in the background.

## Usage

```jsonc
// Exact mode (built-in compatible)
{ "path": "src/main.ts", "edits": [{ "oldText": "const x = 1", "newText": "const y = 2" }] }

// Structural mode (pattern syntax: $A one node, $$$A zero+, $$$ any)
{ "path": "src/main.ts", "edits": [
    { "pattern": "foo($A)", "replace": "bar($A)" },
    { "pattern": "foo()", "insertAfter": "baz();" },
    { "pattern": "oldCall();", "delete": true },
    { "pattern": "foo($A)", "replace": "bar($A)", "context": "function main() { $$$ }" },
    { "pattern": "foo($A)", "replace": "bar($A)", "matchIndex": 1 },
    { "pattern": "foo($A)", "replace": "bar($A)", "all": true }
] }
```

`ast_find` locates code before editing:

```
ast_find { "path": "src/main.ts", "pattern": "foo($A)" }
ast_find { "path": "src/main.ts", "kind": "function_declaration" }
ast_find { "path": "src/main.ts", "position": "12:5" }
```

## Development

Dev environment is the nix flake — run everything through `nix develop`:

```bash
nix develop -c npm install   # dev deps (once)
nix develop -c cargo test
nix develop -c cargo clippy --all-targets -- -D warnings
nix develop -c cargo fmt --check
nix develop -c npx tsc --noEmit
nix develop -c npx @biomejs/biome ci --error-on-warnings .
nix develop -c npm run test:ts   # TS unit + integration + binary downloader
nix build                     # binary → result/bin/pi-ast-edit
```

Commit through the shell — `nix develop -c git commit` (hooks need its
toolchain; never `--no-verify`).

## Telemetry

Optional: record every `edit` call as a per-session entry and analyze
failures with the session model. Enable via `~/.pi/agent/settings.json`:

```jsonc
{ "piAstEdit": { "traceEnabled": true, "insightsLines": 300 } }
```

Then run `/ast-edit-insights` (optional count or `all`) — the model clusters
failure patterns and proposes concrete fixes for the tool's guidelines.