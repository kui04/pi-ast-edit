mod edit;
mod find;
mod languages;
mod protocol;
mod util;

use anyhow::{Result, bail};
use serde_json::Value;
use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
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
