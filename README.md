# pi-ast-edit

A [pi](https://github.com/earendil-works/pi) extension that routes **all file
edits through [ast-grep](https://github.com/ast-grep/ast-grep)** — AST-aware
structural matching — for the 28 supported languages, with exact-text
fallback for everything else.

When this extension is loaded, the built-in `edit` tool is replaced by an
ast-grep-powered implementation, and two helper tools are added:
`ast_find` (structural search) and `ast_languages` (supported file types).

## Why

The built-in `edit` tool matches exact text. That fails when the model's
memory of whitespace is slightly off, and it can match the *wrong* occurrence
— including partial tokens (`foo` inside `foobar`) or text inside strings and
comments. ast-grep matches **whole AST nodes**:

- whitespace-insensitive: `foo(1, 2)` matches `foo(1,2)`
- `$A` captures one node, `$$$A` captures zero or more, `$$$` matches any
- replacements are parsed and validated; the whole file is re-parsed after
  editing — a change that would break syntax (e.g. drop a closing bracket)
  is **rejected without writing**

## Architecture

```
pi (agent) ── edit / ast_find / ast_languages
      │  (JSON over stdin/stdout)
      ▼
pi-ast-edit (Rust binary, ast-grep-core 0.45.3)
      │
      ▼
tree-sitter grammars (28 languages, compiled in)
```

- `src/` — Rust binary: `edit`, `find`, `languages` commands
- `index.ts` + `tools/` — pi extension (TypeScript, loaded via jiti)
- `flake.nix` — nix flake with rust-overlay

### Safety model

1. **Replacement validation** — every replacement/insertion is parsed
   standalone; unbalanced brackets or partial fragments are rejected with
   the parse error.
2. **Whole-file verification** — after all edits, the file is re-parsed;
   if new syntax errors appear the batch is rolled back, nothing is written.
3. **Uniqueness guard** — a pattern matching multiple nodes fails with the
   full match list (line/col/kind/text); the agent must add `matchIndex`
   (0-based) or `all: true`, or narrow the pattern. This prevents editing
   the wrong occurrence.
4. **Undefined variable check** — replacements referencing `$VAR`s the
   pattern does not capture (or with the wrong arity) are rejected instead
   of being silently dropped.
5. **Exact-mode fallback** — unsupported file types (`.txt`, `.vue`,
   `.toml`, ...) and oldText that cannot be parsed as a node fall back to
   plain text replacement with the same uniqueness semantics as the built-in
   edit tool.

## Install

From GitHub (the real flow) — the binary downloads during install:

```bash
pi install git:github.com/kui04/pi-ast-edit
# or try without installing: pi -e git:github.com/kui04/pi-ast-edit
```

For local development, build the binary and load the repo directly
(same resolution, no symlink step):

```bash
nix build  # or: nix develop -c cargo build --release
pi -e ./index.ts
```

The binary is located automatically in this order:
`PI_AST_EDIT_BIN` env var → `target/release/pi-ast-edit` →
`target/debug/pi-ast-edit` → `result/bin/pi-ast-edit`.
A missing binary is a loud error — the binary is provisioned at install time
(see below), not downloaded on first use.

### Install-time download

During `pi install`, a `postinstall` script fetches the platform binary from
the latest GitHub release into `~/.pi/agent/cache/pi-ast-edit/` (skipped when
a local build exists). Download failures fail the install loudly.

### Publishing a release

The release workflow (`.github/workflows/release.yml`) builds the binary for
linux-x64/-arm64 (musl-static: runs on any distro with no glibc version floor),
darwin-x64/-arm64, and win32-x64 (.exe, static CRT) and attaches them to a
GitHub release. Publish with a tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The download source comes from the `repository` field of `package.json`
(override with `PI_AST_EDIT_REPO=owner/repo`). Delete
`~/.pi/agent/cache/pi-ast-edit/` to force a re-download.

## Usage

The `edit` tool accepts two modes per edit:

```jsonc
// Exact mode (built-in compatible)
{ "path": "src/main.ts", "edits": [{ "oldText": "const x = 1", "newText": "const y = 2" }] }

// Structural mode
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

```bash
nix develop          # rust toolchain (rust-overlay) + nodejs + gcc
nix develop -c cargo test        # unit + integration tests
nix develop -c cargo clippy --all-targets
npm install          # dev deps for typechecking the extension
npx tsc --noEmit     # typecheck the extension
nix build            # build the binary (result/bin/pi-ast-edit)
```

End-to-end tests drive real `pi` with a real model (3 journeys, several
minutes). Config via `scripts/.env` — copy `scripts/.env.example` first.
All `.env` entries are passed to pi, so provider API keys go there too:

```bash
cp scripts/.env.example scripts/.env  # then set PI_E2E_MODEL
node scripts/test-e2e.mjs
```

Pre-commit gate (clippy, rustfmt, Biome) — install once per clone:

```bash
git config core.hooksPath .githooks
```
