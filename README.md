# pi-ast-edit

**[中文 (Chinese)](README.zh-CN.md)**

A [pi](https://github.com/earendil-works/pi) extension that routes **all file edits through
[ast-grep](https://github.com/ast-grep/ast-grep)** — AST-aware structural matching for 28
languages, with exact-text fallback for everything else. It replaces the built-in `edit`
tool and adds two helpers: `ast_find` (structural search) and `ast_languages` (supported
file types).

## What you get

- **`edit` is replaced.** Edits go through a Rust binary instead of text search: the agent
  can hand over an ast-grep pattern, which matches **whole AST nodes** — whitespace and
  formatting drift no longer break a change, and a fragment inside a string or comment can
  no longer be hit by accident.
- **`ast_find` / `ast_languages`.** Look code up before editing — by pattern, by node kind,
  or by `line:col` — and list the supported file types (28 languages, 71 extensions).
- **Nothing is written unless it is safe.** A structural replacement must parse on its own,
  the **whole file is re-parsed after the edit**, and the edit is rejected unless the file
  parses cleanly afterwards — a file that already had syntax errors has to have them fixed
  by the same edit. An ambiguous match is refused (never "first match wins") and the full
  match list is handed back, so the agent can pick one deliberately.

## Install

```bash
pi install git:github.com/kui04/pi-ast-edit            # follow the default branch
pi install git:github.com/kui04/pi-ast-edit@v0.2.3     # or pin a release
pi -e git:github.com/kui04/pi-ast-edit                 # try it without installing
```

The Rust binary comes from the release page: prebuilt for Linux x64/arm64, macOS x64/arm64
and Windows x64. Elsewhere — or to run a local build — use `nix build` (or
`nix develop -c cargo build --release`), then `pi -e ./index.ts`. The binary is looked up in
`PI_AST_EDIT_BIN`, then local builds, then the download cache. If it is missing, `edit`
warns once, falls back to pi's built-in editor for plain `oldText`/`newText` edits (a
structural edit instead fails with an explanation rather than being silently skipped), and
the download is retried in the background.

## Configuration

Both settings are optional and live under `ast-edit` in `~/.pi/agent/settings.json`
(`$PI_CODING_AGENT_DIR` is respected):

```jsonc
{
  "ast-edit": {
    "autoReflect": false,    // reflection: ON by default (see below)
    "reflectAfterErrors": 3, // reflect once this many edit failures piled up (default 3)
    "reflectModel": {        // model for the reflection request; default = the session model
      "providerId": "openrouter",
      "modelId": "nvidia/nemotron",
      "thinkingLevel": "high" // off|minimal|low|medium|high|xhigh|max
    },
    "traceEnabled": false,   // developer log: OFF by default
    "tracePath": "…"         // default `~/.pi/agent/ast-edit.log.jsonl`
  }
}
```

### Reflection (on by default)

The input is the failed `edit` calls of this extension in the current session — no log
file is involved. After a turn in which the un-reflected count reached
`reflectAfterErrors`, one clean, session-independent request is made (failure lines only:
no conversation, tools or prompts), and its verdict is queued into the transcript as an
`ast-edit.reflection` message for the next turn. **That is one extra model request per
trigger** — which is what the three settings above are for: reflect less often, reflect
with a cheaper or deeper model, or turn it off.

### Trace (off by default)

With `traceEnabled`, every `edit` call appends one JSON line to
`~/.pi/agent/ast-edit.log.jsonl` (tool call id, session, model, path, mode, result,
timing, error) — one line per call, so `grep` and `jq` work directly.

## Limits

- Structural mode needs a language ast-grep supports (the 28 `ast_languages` lists);
  anything else — `.toml`, `.sql`, `.vue`, extensionless scripts — falls back to plain
  exact-text replacement, without AST-aware matching or validation.
- Exact mode is **byte-exact**: a whitespace or line-break difference means "not found".
  It also takes no structural arguments (`insertBefore` / `insertAfter` / `delete` are
  rejected with a hint to use the pattern form).
- One call edits existing files only: the file must exist, be writable and be UTF-8 (a BOM
  and CRLF endings are preserved). Files cannot be created or deleted, and two edits in the
  same call do not see each other's output.
- Patterns must be valid, parseable code of that language, and grammars differ in what they
  accept: some expression-level shapes (Dart among them) do not parse as patterns at all.

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
nix build                        # binary → result/bin/pi-ast-edit
```

Commit through the shell — `nix develop -c git commit` (the pre-commit hooks need its
toolchain; never `--no-verify`). [AGENTS.md](AGENTS.md) has the same list plus the
conventions and the release steps.
