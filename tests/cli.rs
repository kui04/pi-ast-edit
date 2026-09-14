//! End-to-end tests that run the compiled binary, exercising the same
//! stdin/stdout JSON protocol the pi extension uses.

use std::io::Write;
use std::process::{Command, Stdio};

fn run_bin(args: &[&str], input: &str) -> (i32, serde_json::Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_pi-ast-edit"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn pi-ast-edit");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(input.as_bytes())
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait");
    let code = out.status.code().unwrap_or(1);
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_else(|_| {
        panic!(
            "invalid JSON output (exit {code}): {stdout}\nstderr: {}",
            String::from_utf8_lossy(&out.stderr)
        )
    });
    (code, parsed)
}

#[test]
fn edit_roundtrip_via_binary() {
    let req = serde_json::json!({
        "content": "var a = 1; let b = 2;",
        "edits": [{ "pattern": "var $A = $B", "replace": "let $A = $B" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 0);
    assert_eq!(out["newContent"], "let a = 1; let b = 2;");
    assert_eq!(out["applied"][0]["matchedText"], "var a = 1;");
    assert_eq!(out["preErrors"].as_array().unwrap().len(), 0);
}

#[test]
fn edit_rejects_broken_replacement_via_binary() {
    let req = serde_json::json!({
        "content": "let a = 1;",
        "edits": [{ "pattern": "let $A = $B", "replace": "let $A = " }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    assert!(
        out["error"]
            .as_str()
            .unwrap()
            .contains("produces invalid code")
    );
}

#[test]
fn edit_unsupported_language_falls_back_to_exact_text() {
    let req = serde_json::json!({
        "content": "hello world",
        "edits": [{ "oldText": "world", "newText": "there" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.txt"], &req.to_string());
    assert_eq!(code, 0);
    assert_eq!(out["newContent"], "hello there");
}

#[test]
fn find_reports_matches_with_vars() {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("pi-ast-edit-test-{}.js", std::process::id()));
    std::fs::write(&path, "foo(1); foo(2);").expect("write fixture");
    let (code, out) = run_bin(
        &[
            "find",
            "--path",
            path.to_str().unwrap(),
            "--pattern",
            "foo($A)",
        ],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 0);
    assert_eq!(out["language"], "JavaScript");
    assert_eq!(out["matches"].as_array().unwrap().len(), 2);
    assert_eq!(out["matches"][0]["vars"][0]["name"], "A");
    assert_eq!(out["matches"][0]["vars"][0]["text"], "1");
}

#[test]
fn languages_lists_rust() {
    let (code, out) = run_bin(&["languages"], "");
    assert_eq!(code, 0);
    let names: Vec<&str> = out["languages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Rust"));
    assert!(names.contains(&"TypeScript"));
    assert!(names.contains(&"Python"));
    assert!(names.contains(&"Go"));
}

/// Write a unique temp fixture and return its path; caller removes it.
fn fixture(name: &str, content: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("pi-ast-edit-{}-{name}", std::process::id()));
    std::fs::write(&path, content).expect("write fixture");
    path
}

#[test]
fn find_kind_search() {
    let path = fixture("kind.js", "function a() {}\nfunction b() {}\nlet c = 1;");
    let (code, out) = run_bin(
        &[
            "find",
            "--path",
            path.to_str().unwrap(),
            "--kind",
            "function_declaration",
        ],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 0);
    assert_eq!(out["matches"].as_array().unwrap().len(), 2);
    assert_eq!(out["matches"][0]["kind"], "function_declaration");
}

#[test]
fn find_position_mode() {
    let path = fixture("pos.js", "let a = 1;");
    let (code, out) = run_bin(
        &[
            "find",
            "--path",
            path.to_str().unwrap(),
            "--position",
            "1:5",
        ],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 0);
    assert_eq!(out["node"]["kind"], "identifier");
    assert_eq!(out["node"]["text"], "a");
    // immediate parent first, then up the chain
    assert_eq!(out["ancestors"][0]["kind"], "variable_declarator");
    assert_eq!(out["ancestors"][1]["kind"], "lexical_declaration");
}

#[test]
fn find_position_out_of_range() {
    let path = fixture("pos2.js", "let a = 1;");
    let (code, out) = run_bin(
        &[
            "find",
            "--path",
            path.to_str().unwrap(),
            "--position",
            "99:1",
        ],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 1);
    assert!(out["error"].as_str().unwrap().contains("outside the file"));
}

#[test]
fn find_context_filter() {
    let path = fixture(
        "ctx.js",
        "function a() { foo(1); }\nfunction b() { foo(2); }",
    );
    let (code, out) = run_bin(
        &[
            "find",
            "--path",
            path.to_str().unwrap(),
            "--pattern",
            "foo($A)",
            "--context",
            "function a() { $$$ }",
        ],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 0);
    assert_eq!(out["matches"].as_array().unwrap().len(), 1);
}

#[test]
fn find_empty_context_and_kind_are_absent() {
    // a model that fills every field sends `--context ""` / `--kind ""` for
    // "unused"; an empty value is absent, so the pattern alone drives the search
    let path = fixture(
        "empty-ctx.js",
        "function a() { foo(1); }\nfunction b() { foo(2); }",
    );
    let (code, out) = run_bin(
        &[
            "find",
            "--path",
            path.to_str().unwrap(),
            "--pattern",
            "foo($A)",
            "--context",
            "",
            "--kind",
            "",
        ],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 0);
    assert_eq!(out["matches"].as_array().unwrap().len(), 2);
}

#[test]
fn find_empty_position_and_limit_are_absent() {
    // `--position ""` is "unused", not a position, and `--limit ""` leaves the
    // default cap in place instead of failing the integer parse
    let path = fixture("empty-pos.js", "let a = 1;\nlet b = 2;");
    let (code, out) = run_bin(
        &[
            "find",
            "--path",
            path.to_str().unwrap(),
            "--pattern",
            "let $A = $B",
            "--position",
            "",
            "--limit",
            "",
        ],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 0);
    assert_eq!(out["matches"].as_array().unwrap().len(), 2);
}

#[test]
fn find_reports_syntax_errors() {
    let path = fixture("broken.js", "let = ;");
    let (code, out) = run_bin(
        &["find", "--path", path.to_str().unwrap(), "--pattern", "let"],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 0);
    assert!(!out["errors"].as_array().unwrap().is_empty());
}

#[test]
fn find_unsupported_language() {
    let path = fixture("note.txt", "hello");
    let (code, out) = run_bin(
        &[
            "find",
            "--path",
            path.to_str().unwrap(),
            "--pattern",
            "hello",
        ],
        "",
    );
    let _ = std::fs::remove_file(&path);
    assert_eq!(code, 1);
    assert!(
        out["error"]
            .as_str()
            .unwrap()
            .contains("unsupported language")
    );
}

#[test]
fn edit_invalid_json_request() {
    let (code, out) = run_bin(&["edit", "--path", "x.js"], "not json at all");
    assert_eq!(code, 1);
    assert!(
        out["error"]
            .as_str()
            .unwrap()
            .contains("invalid edit request")
    );
}

#[test]
fn edit_missing_selector() {
    let req = serde_json::json!({
        "content": "let a = 1;",
        "edits": [{ "replace": "x" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    assert!(
        out["error"]
            .as_str()
            .unwrap()
            .contains("specify exactly one")
    );
}

#[test]
fn edit_match_index_out_of_range() {
    let req = serde_json::json!({
        "content": "foo(1); foo(2);",
        "edits": [{ "pattern": "foo($A)", "replace": "bar($A)", "matchIndex": 9 }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    assert!(out["error"].as_str().unwrap().contains("out of range"));
}

#[test]
fn edit_preserves_missing_trailing_newline() {
    let req = serde_json::json!({
        "content": "foo();", // no trailing newline
        "edits": [{ "pattern": "foo()", "replace": "bar()" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 0);
    assert_eq!(out["newContent"], "bar();");
    assert!(!out["newContent"].as_str().unwrap().ends_with('\n'));
}

#[test]
fn edit_empty_pattern_and_context_fall_back_to_exact() {
    // pattern "" is "unused", so the oldText/newText pair drives the edit, and
    // the empty context is ignored instead of failing the whole request
    let req = serde_json::json!({
        "content": "foo(1);",
        "edits": [{
            "pattern": "",
            "context": "",
            "oldText": "foo(1);",
            "newText": "bar(1);"
        }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 0);
    assert_eq!(out["newContent"], "bar(1);");
}

#[test]
fn edit_empty_insert_before_is_not_an_operation() {
    // an empty insertion used to count as a second operation and fail the
    // "specify only one of" guard
    let req = serde_json::json!({
        "content": "foo(1);",
        "edits": [{ "pattern": "foo(1);", "replace": "bar(1);", "insertBefore": "" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 0);
    assert_eq!(out["newContent"], "bar(1);");
}

#[test]
fn edit_empty_replace_still_replaces_with_nothing() {
    // "" in replace is an instruction (delete the matched text), not a sentinel
    let req = serde_json::json!({
        "content": "foo(1);",
        "edits": [{ "pattern": "foo(1);", "replace": "" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 0);
    assert_eq!(out["newContent"], "");
}

#[test]
fn edit_empty_new_text_still_deletes_text() {
    // "" in newText means "replace with nothing". A two-statement oldText
    // cannot be matched structurally, so this goes through the plain-text
    // exact path, which requires newText to be present at all.
    let req = serde_json::json!({
        "content": "let a = 1;\nlet b = 2;",
        "edits": [{ "oldText": "let a = 1;\nlet b = 2;", "newText": "" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 0);
    assert_eq!(out["newContent"], "");
}

#[test]
fn edit_exact_insert_before_is_rejected() {
    // exact mode takes no op: it used to ignore insertBefore and delete the
    // matched text (newText "" satisfied the replacement slot) instead.
    let req = serde_json::json!({
        "content": "const a = 1;\nconst b = 2;",
        "edits": [{ "oldText": "const a = 1;", "insertBefore": "const z = 9;", "newText": "" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    let err = out["error"].as_str().unwrap();
    assert!(err.contains("insertBefore"), "{err}");
    assert!(err.contains("structural-mode"), "{err}");
}

#[test]
fn edit_exact_whole_node_without_new_text_is_rejected() {
    // a whole-node oldText (structurally matched) used to be deleted silently
    let req = serde_json::json!({
        "content": "const a = 1;\nconst b = 2;",
        "edits": [{ "oldText": "const a = 1;" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    let err = out["error"].as_str().unwrap();
    assert!(err.contains("newText is required with oldText"), "{err}");
}

#[test]
fn edit_exact_not_found_reports_the_nearest_line() {
    // indentation off by two spaces: the error must point at the line and show
    // both versions, so the agent does not have to re-read the file to guess
    let req = serde_json::json!({
        "content": "function f() {\n    let a = 1;\n}",
        "edits": [{ "oldText": "function f() {\n  let a = 1;\n}", "newText": "x" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    let err = out["error"].as_str().unwrap();
    assert!(err.contains("could not find the exact text"), "{err}");
    assert!(err.contains("nearest: line 2"), "{err}");
}

#[test]
fn edit_missing_new_text_hints_at_the_delete_form() {
    let req = serde_json::json!({
        "content": "let a = 1;\nlet b = 2;",
        "edits": [{ "oldText": "let a = 1;\nlet b = 2;" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    let err = out["error"].as_str().unwrap();
    assert!(err.contains("newText is required with oldText"), "{err}");
    assert!(err.contains(r#"newText: """#), "{err}");
}

#[test]
fn edit_context_excluding_every_match_is_reported() {
    let req = serde_json::json!({
        "content": "foo(1);",
        "edits": [{
            "pattern": "foo($A)",
            "replace": "bar($A)",
            "context": "function nope() { $$$ }"
        }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    let err = out["error"].as_str().unwrap();
    assert!(err.contains("matched 1 node(s)"), "{err}");
    assert!(err.contains("excluded them all"), "{err}");
}

#[test]
fn edit_invalid_insert_reports_the_missing_token() {
    let req = serde_json::json!({
        "content": "let a = 1;",
        "edits": [{ "pattern": "let $A = $B", "insertBefore": "function f() {" }]
    });
    let (code, out) = run_bin(&["edit", "--path", "x.js"], &req.to_string());
    assert_eq!(code, 1);
    let err = out["error"].as_str().unwrap();
    assert!(err.contains("line 1, col 15: missing `}`"), "{err}");
}

#[test]
fn trace_file_gets_json_lines_when_enabled() {
    // PI_AST_EDIT_TRACE enables the JSON-lines trace layer (the edit-tool
    // reflection loop); the log must carry both the info outcome and the
    // per-edit debug event enriched in src/edit.rs.
    let trace = std::env::temp_dir().join(format!("pi-ast-edit-trace-{}.log", std::process::id()));
    let _ = std::fs::remove_file(&trace);
    let req = serde_json::json!({
        "content": "foo(1);",
        "edits": [{ "pattern": "foo($A)", "replace": "bar($A)" }]
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_pi-ast-edit"))
        .args(["edit", "--path", "x.js"])
        .env("PI_AST_EDIT_TRACE", &trace)
        .env("PI_AST_EDIT_TRACE_LEVEL", "debug")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn pi-ast-edit");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(req.to_string().as_bytes())
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait");
    assert_eq!(out.status.code(), Some(0));
    let content = std::fs::read_to_string(&trace).expect("trace file written");
    let _ = std::fs::remove_file(&trace);
    let parsed: Vec<serde_json::Value> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("trace line is JSON"))
        .collect();
    assert!(
        parsed
            .iter()
            .any(|l| l["fields"]["message"] == "edit applied"),
        "{content}"
    );
    assert!(
        parsed
            .iter()
            .any(|l| l["fields"]["message"] == "pattern edit" && l["fields"]["matched"] == 1),
        "{content}"
    );
}
