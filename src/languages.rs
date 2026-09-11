use anyhow::Result;
use serde_json::Value;

use crate::protocol::LanguageInfo;

/// Mirrors the extension table in ast-grep-language (its `extensions()` fn is
/// private). Only used for the `languages` info command; actual language
/// detection uses `SupportLang::from_path`.
const EXTENSIONS: &[(&str, &[&str])] = &[
    (
        "Bash",
        &[
            "bash", "sh", "zsh", "ksh", "bats", "env", "cgi", "command", "fcgi", "tmux", "tool",
        ],
    ),
    ("C", &["c", "h"]),
    (
        "Cpp",
        &["cc", "hpp", "cpp", "c++", "hh", "cxx", "cu", "ino"],
    ),
    ("CSharp", &["cs"]),
    ("Css", &["css", "scss"]),
    ("Dart", &["dart"]),
    ("Elixir", &["ex", "exs"]),
    ("Go", &["go"]),
    ("Haskell", &["hs"]),
    ("Hcl", &["hcl", "nomad", "tf", "tfvars", "workflow"]),
    ("Html", &["html", "htm", "xhtml"]),
    ("Java", &["java"]),
    ("JavaScript", &["cjs", "js", "mjs", "jsx"]),
    ("Json", &["json"]),
    ("Kotlin", &["kt", "ktm", "kts"]),
    ("Lua", &["lua"]),
    ("Markdown", &["markdown", "md"]),
    ("Nix", &["nix"]),
    ("Php", &["php"]),
    ("Python", &["py", "py3", "pyi", "bzl", "bazel"]),
    ("Ruby", &["rb", "rbw", "gemspec"]),
    ("Rust", &["rs"]),
    ("Scala", &["scala", "sc", "sbt"]),
    ("Solidity", &["sol"]),
    ("Swift", &["swift"]),
    ("Tsx", &["tsx"]),
    ("TypeScript", &["ts", "cts", "mts"]),
    ("Yaml", &["yaml", "yml"]),
];

pub fn run() -> Result<Value> {
    let languages: Vec<LanguageInfo> = EXTENSIONS
        .iter()
        .map(|(name, exts)| LanguageInfo {
            name: name.to_string(),
            extensions: exts.iter().map(|e| e.to_string()).collect(),
        })
        .collect();
    tracing::info!(languages = languages.len(), "languages listed");
    Ok(serde_json::to_value(
        serde_json::json!({ "languages": languages }),
    )?)
}
