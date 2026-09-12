mod edit;
mod find;
mod languages;
mod protocol;
mod util;

use std::fs::OpenOptions;
use std::io::Write;

use anyhow::{Result, bail};
use serde_json::Value;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::BoxMakeWriter;
use tracing_subscriber::prelude::*;

/// JSON-lines trace writer for the edit-tool reflection loop, enabled by the
/// extension (tools/reflect.ts) via PI_AST_EDIT_TRACE. Unwritable paths
/// degrade to sink — logging must never break an edit. When the env var is
/// unset the writer is a permanent sink (no file, no I/O).
fn trace_writer() -> BoxMakeWriter {
    let path = std::env::var("PI_AST_EDIT_TRACE")
        .ok()
        .filter(|p| !p.is_empty());
    BoxMakeWriter::new(move || match &path {
        Some(path) => OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map(|f| Box::new(f) as Box<dyn Write + Send + Sync>)
            .unwrap_or_else(|error| {
                eprintln!("pi-ast-edit: trace file `{path}` unwritable ({error}); dropping trace");
                Box::new(std::io::sink()) as Box<dyn Write + Send + Sync>
            }),
        None => Box::new(std::io::sink()) as Box<dyn Write + Send + Sync>,
    })
}

fn main() {
    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")));
    let trace_level = std::env::var("PI_AST_EDIT_TRACE_LEVEL")
        .map(EnvFilter::new)
        .unwrap_or_else(|_| EnvFilter::new("debug"));
    tracing_subscriber::registry()
        .with(stderr_layer)
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_writer(trace_writer())
                .with_filter(trace_level),
        )
        .init();

    match run() {
        Ok(value) => {
            println!(
                "{}",
                serde_json::to_string(&value).expect("serialize output")
            );
        }
        Err(error) => {
            tracing::error!(error = %error, "command failed");
            let err = serde_json::json!({ "error": format!("{error:#}") });
            println!("{}", serde_json::to_string(&err).expect("serialize error"));
            std::process::exit(1);
        }
    }
}

fn run() -> Result<Value> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    tracing::debug!(args = ?args, "command");
    match args.first().map(String::as_str) {
        Some("languages") => languages::run(),
        Some("find") => find::run(&args[1..]),
        Some("edit") => edit::run(&args[1..]),
        Some(other) => bail!("unknown command `{other}`"),
        None => bail!("usage: pi-ast-edit <languages|find|edit> [options]"),
    }
}
