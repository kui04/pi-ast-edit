use std::io::Read;

use anyhow::{Context, Result, bail};
use ast_grep_core::Pattern;
use ast_grep_core::replacer::{Replacer, TemplateFix};
use ast_grep_core::source::Edit;
use ast_grep_language::{Language, LanguageExt, SupportLang};
use serde_json::Value;

use crate::protocol::{AppliedEdit, EditRequest, EditResult, EditSpec};
use crate::util::{
    Doc, GMatch, GNode, MAX_FRAGMENT_TEXT, MAX_SNIPPET, col_of, collect_errors, filter_context,
    find_non_nested, format_errors, get_arg, line_of, scan_vars, truncate,
};

struct PlannedEdit {
    edit: Edit<String>,
    applied: AppliedEdit,
}

/// Replacer that inserts text verbatim, without `$VAR` substitution or
/// re-indentation. Used by exact mode so newText stays literal (matching the
/// built-in edit tool's semantics).
struct LiteralReplacer<'a>(&'a str);

impl Replacer<Doc> for LiteralReplacer<'_> {
    fn generate_replacement(&self, _nm: &GMatch<'_>) -> Vec<u8> {
        self.0.as_bytes().to_vec()
    }
}

pub fn run(args: &[String]) -> Result<Value> {
    let path = get_arg(args, "--path")?;
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .context("failed to read request from stdin")?;
    let req: EditRequest = serde_json::from_str(&buf).context("invalid edit request")?;
    if req.edits.is_empty() {
        bail!("edits must contain at least one edit");
    }
    tracing::debug!(path = %path, edits = req.edits.len(), "edit request");
    let result = match SupportLang::from_path(&path) {
        Some(lang) => edit_structural(&req, lang)?,
        None => edit_exact(&req)?,
    };
    tracing::info!(
        path = %path,
        applied = result.applied.len(),
        pre_errors = result.pre_errors.len(),
        post_errors = result.post_errors.len(),
        "edit applied",
    );
    Ok(serde_json::to_value(result)?)
}

/// Structural editing for ast-grep supported languages.
///
/// Safety model:
/// 1. Every replacement/insertion is parsed standalone and must be valid code
///    (catches unbalanced brackets, partial fragments, ...).
/// 2. The whole file is re-parsed after all edits; if the ERROR node count
///    increased, the batch is rejected and nothing is written.
/// 3. A pattern matching multiple nodes fails unless `matchIndex` or `all`
///    is given, with every match listed so the agent can disambiguate.
fn edit_structural(req: &EditRequest, lang: SupportLang) -> Result<EditResult> {
    let ast = lang.ast_grep(&req.content);
    let root = ast.root();
    let pre_errors = collect_errors(&root);
    tracing::debug!(pre_errors = pre_errors.len(), "structural edit: planning");
    let mut plan: Vec<PlannedEdit> = Vec::new();
    for (i, spec) in req.edits.iter().enumerate() {
        plan.extend(plan_edit(
            &root,
            spec,
            lang,
            &req.content,
            &format!("edits[{i}]"),
        )?);
    }
    check_overlap(&plan)?;
    let (new_content, applied) = apply_plan(&req.content, plan)?;
    let post_errors = {
        let ast2 = lang.ast_grep(&new_content);
        collect_errors(&ast2.root())
    };
    if post_errors.len() > pre_errors.len() {
        bail!(
            "the edit would introduce {} new syntax error(s); rolled back, file unchanged (had {}, would have {}):\n{}",
            post_errors.len() - pre_errors.len(),
            pre_errors.len(),
            post_errors.len(),
            format_errors(&post_errors)
        );
    }
    Ok(EditResult {
        new_content,
        applied,
        pre_errors,
        post_errors,
    })
}

/// Plain exact-text editing for languages ast-grep does not support
/// (same semantics as the built-in edit tool: unique match, no overlap).
fn edit_exact(req: &EditRequest) -> Result<EditResult> {
    let mut plan: Vec<PlannedEdit> = Vec::new();
    for (i, spec) in req.edits.iter().enumerate() {
        let label = format!("edits[{i}]");
        if spec.pattern.is_some() {
            bail!(
                "{label}: this file's language is not supported by ast-grep; only oldText/newText (exact) edits are available"
            );
        }
        plan.extend(plan_exact_text(&req.content, spec, &label)?);
    }
    check_overlap(&plan)?;
    let (new_content, applied) = apply_plan(&req.content, plan)?;
    Ok(EditResult {
        new_content,
        applied,
        pre_errors: vec![],
        post_errors: vec![],
    })
}

fn plan_edit(
    root: &GNode,
    spec: &EditSpec,
    lang: SupportLang,
    content: &str,
    label: &str,
) -> Result<Vec<PlannedEdit>> {
    match (spec.pattern.is_some(), spec.old_text.is_some()) {
        (true, false) => plan_pattern(root, spec, lang, label),
        (false, true) => plan_exact(root, spec, lang, content, label),
        _ => bail!("{label}: specify exactly one of `pattern` or `oldText`"),
    }
}

fn plan_pattern(
    root: &GNode,
    spec: &EditSpec,
    lang: SupportLang,
    label: &str,
) -> Result<Vec<PlannedEdit>> {
    let pattern_src = spec
        .pattern
        .as_deref()
        .with_context(|| format!("{label}: pattern mode requires `pattern`"))?;
    let pattern = Pattern::try_new(pattern_src, lang)
        .with_context(|| format!("{label}: invalid pattern `{pattern_src}`"))?;
    if pattern.has_error() {
        bail!("{label}: pattern `{pattern_src}` is not valid syntax")
    }
    let ctx = build_context(spec.context.as_deref(), lang, label)?;
    let matches: Vec<GMatch> = filter_context(find_non_nested(root, &pattern), &ctx);
    let selected = select_matches(&matches, spec, label, pattern_src, "pattern")?;
    tracing::debug!(
        label = %label,
        pattern = %truncate(pattern_src, MAX_SNIPPET),
        matched = matches.len(),
        selected = selected.len(),
        "pattern edit"
    );
    let op = pick_op(spec, label)?;
    let mut out = Vec::new();
    for nm in selected {
        out.push(build_edit(nm, &pattern, spec, op, false, lang, label)?);
    }
    Ok(out)
}

/// Exact mode: oldText is matched structurally first (whitespace-insensitive,
/// whole nodes only — never partial tokens or text inside strings/comments),
/// falling back to plain text search.
fn plan_exact(
    root: &GNode,
    spec: &EditSpec,
    lang: SupportLang,
    content: &str,
    label: &str,
) -> Result<Vec<PlannedEdit>> {
    let old_text = require_old_text(spec, label)?;
    if let Ok(pattern) = Pattern::try_new(old_text, lang)
        && !pattern.has_error()
    {
        let ctx = build_context(spec.context.as_deref(), lang, label)?;
        let matches: Vec<GMatch> = filter_context(find_non_nested(root, &pattern), &ctx);
        if !matches.is_empty() {
            let selected = select_matches(&matches, spec, label, old_text, "text")?;
            tracing::debug!(
                label = %label,
                old_text = %truncate(old_text, MAX_SNIPPET),
                matched = matches.len(),
                "exact text matched structurally"
            );
            let mut out = Vec::new();
            for nm in selected {
                out.push(build_edit(
                    nm, &pattern, spec, "replace", true, lang, label,
                )?);
            }
            return Ok(out);
        }
    }
    plan_exact_text(content, spec, label)
}

fn build_context(context: Option<&str>, lang: SupportLang, label: &str) -> Result<Option<Pattern>> {
    match context {
        Some(c) => {
            Ok(Some(Pattern::try_new(c, lang).with_context(|| {
                format!("{label}: invalid context `{c}`")
            })?))
        }
        None => Ok(None),
    }
}

/// OldText every exact-path edit needs, borrowed from the spec.
fn require_old_text<'a>(spec: &'a EditSpec, label: &str) -> Result<&'a str> {
    let old_text = spec
        .old_text
        .as_deref()
        .with_context(|| format!("{label}: exact mode requires oldText"))?;
    if old_text.is_empty() {
        bail!("{label}: oldText must not be empty")
    }
    Ok(old_text)
}

fn plan_exact_text(content: &str, spec: &EditSpec, label: &str) -> Result<Vec<PlannedEdit>> {
    let old_text = spec
        .old_text
        .as_deref()
        .with_context(|| format!("{label}: exact mode requires oldText"))?;
    if old_text.is_empty() {
        bail!("{label}: oldText must not be empty")
    }
    let new_text = spec
        .new_text
        .as_deref()
        .with_context(|| format!("{label}: newText is required with oldText"))?;
    let positions: Vec<usize> = content.match_indices(old_text).map(|(i, _)| i).collect();
    if positions.is_empty() {
        bail!(
            "{label}: could not find the exact text in the file. oldText must match exactly including all whitespace and newlines."
        );
    }
    let selected: Vec<usize> = if let Some(idx) = spec.match_index {
        vec![*positions.get(idx).with_context(|| {
            format!(
                "{label}: matchIndex {idx} out of range ({} occurrence(s))",
                positions.len()
            )
        })?]
    } else if spec.all || positions.len() == 1 {
        positions.clone()
    } else {
        let list: Vec<String> = positions
            .iter()
            .enumerate()
            .map(|(i, p)| format!("  [{i}] line {}", line_of(content, *p) + 1))
            .collect();
        bail!(
            "{label}: found {} occurrences of the text. Add `matchIndex` (0-based) to pick one, `all: true` to edit all, or provide more context:\n{}",
            positions.len(),
            list.join("\n")
        );
    };
    tracing::debug!(
        label = %label,
        old_text = %truncate(old_text, MAX_SNIPPET),
        occurrences = positions.len(),
        selected = selected.len(),
        "exact text edit"
    );
    Ok(selected
        .into_iter()
        .map(|p| PlannedEdit {
            edit: Edit {
                position: p,
                deleted_length: old_text.len(),
                inserted_text: new_text.as_bytes().to_vec(),
            },
            applied: AppliedEdit {
                op: "replace".into(),
                pattern: old_text.into(),
                matched_text: old_text.into(),
                new_text: new_text.into(),
                line: line_of(content, p) + 1,
                col: col_of(content, p) + 1,
                kind: "text".into(),
            },
        })
        .collect())
}

fn select_matches<'r, 'a>(
    matches: &'a [GMatch<'r>],
    spec: &EditSpec,
    label: &str,
    what: &str,
    what_kind: &str,
) -> Result<Vec<&'a GMatch<'r>>> {
    if matches.is_empty() {
        bail!("{label}: {what_kind} `{what}` matched nothing in the file")
    }
    if let Some(idx) = spec.match_index {
        let m = matches.get(idx).with_context(|| {
            format!(
                "{label}: matchIndex {idx} out of range ({} match(es))",
                matches.len()
            )
        })?;
        return Ok(vec![m]);
    }
    if spec.all {
        return Ok(matches.iter().collect());
    }
    if matches.len() == 1 {
        return Ok(vec![&matches[0]]);
    }
    let list: Vec<String> = matches
        .iter()
        .enumerate()
        .map(|(i, m)| {
            format!(
                "  [{i}] line {}, col {} ({}): {}",
                m.start_pos().line() + 1,
                m.start_pos().column(m) + 1,
                m.kind(),
                truncate(&m.text(), MAX_SNIPPET)
            )
        })
        .collect();
    bail!(
        "{label}: {what_kind} `{what}` matches {} nodes. Add `matchIndex` (0-based) to pick one, `all: true` to edit all, or narrow the pattern:\n{}",
        matches.len(),
        list.join("\n")
    )
}

fn pick_op(spec: &EditSpec, label: &str) -> Result<&'static str> {
    let mut ops = Vec::new();
    if spec.replace.is_some() {
        ops.push("replace");
    }
    if spec.insert_before.is_some() {
        ops.push("insert_before");
    }
    if spec.insert_after.is_some() {
        ops.push("insert_after");
    }
    if spec.delete {
        ops.push("delete");
    }
    match ops.as_slice() {
        [op] => Ok(op),
        [] => bail!("{label}: specify one of replace, insertBefore, insertAfter, or delete"),
        _ => bail!(
            "{label}: specify only one of replace, insertBefore, insertAfter, delete (got: {})",
            ops.join(", ")
        ),
    }
}

/// Per-match info shared by the edit builders.
struct MatchContext {
    line: usize,
    col: usize,
    kind: String,
    matched_text: String,
    pattern_src: String,
}

fn build_edit(
    nm: &GMatch,
    matcher: &Pattern,
    spec: &EditSpec,
    op: &str,
    is_exact: bool,
    lang: SupportLang,
    label: &str,
) -> Result<PlannedEdit> {
    let ctx = MatchContext {
        line: nm.start_pos().line() + 1,
        col: nm.start_pos().column(nm) + 1,
        kind: nm.kind().to_string(),
        matched_text: nm.text().to_string(),
        pattern_src: spec
            .pattern
            .clone()
            .unwrap_or_else(|| spec.old_text.clone().unwrap_or_default()),
    };
    match op {
        "replace" => build_replace_edit(nm, matcher, spec, is_exact, lang, label, ctx),
        "insert_before" | "insert_after" => build_insert_edit(nm, spec, op, lang, label, ctx),
        "delete" => build_delete_edit(nm, ctx),
        other => bail!("{label}: unknown op `{other}`"),
    }
}

fn build_replace_edit(
    nm: &GMatch,
    matcher: &Pattern,
    spec: &EditSpec,
    is_exact: bool,
    lang: SupportLang,
    label: &str,
    ctx: MatchContext,
) -> Result<PlannedEdit> {
    // The exact path carries the replacement in newText and keeps it literal;
    // pattern mode uses replace with $VAR substitution.
    let replace = spec
        .replace
        .as_deref()
        .or(spec.new_text.as_deref())
        .unwrap_or("");
    if !is_exact {
        check_replacement_vars(&ctx.pattern_src, replace, label)?;
    }
    let fix = if is_exact {
        None
    } else {
        Some(
            TemplateFix::try_new(replace, &lang)
                .with_context(|| format!("{label}: invalid replacement"))?,
        )
    };
    let substituted = match &fix {
        Some(f) => String::from_utf8_lossy(&f.generate_replacement(nm)).to_string(),
        None => replace.to_string(),
    };
    validate_fragment(&substituted, lang)
        .with_context(|| format!("{label}: replacement `{replace}` produces invalid code"))?;
    let edit = match &fix {
        Some(f) => nm.make_edit(matcher, f),
        None => nm.make_edit(matcher, &LiteralReplacer(replace)),
    };
    Ok(PlannedEdit {
        edit,
        applied: AppliedEdit {
            op: "replace".into(),
            pattern: ctx.pattern_src,
            matched_text: ctx.matched_text,
            new_text: substituted,
            line: ctx.line,
            col: ctx.col,
            kind: ctx.kind,
        },
    })
}

fn build_insert_edit(
    nm: &GMatch,
    spec: &EditSpec,
    op: &str,
    lang: SupportLang,
    label: &str,
    ctx: MatchContext,
) -> Result<PlannedEdit> {
    let text = if op == "insert_before" {
        spec.insert_before.as_deref().unwrap_or("")
    } else {
        spec.insert_after.as_deref().unwrap_or("")
    };
    validate_fragment(text, lang)
        .with_context(|| format!("{label}: inserted text is not valid code"))?;
    let position = if op == "insert_before" {
        nm.range().start
    } else {
        // insert after the node, extended past immediately following
        // punctuation (e.g. the `;` of the enclosing statement) so the
        // inserted code lands after the whole statement, not inside it
        let mut end = nm.range().end;
        let mut next = nm.next();
        while let Some(n) = next {
            if n.is_named() {
                break;
            }
            end = n.range().end;
            next = n.next();
        }
        end
    };
    Ok(PlannedEdit {
        edit: Edit {
            position,
            deleted_length: 0,
            inserted_text: text.as_bytes().to_vec(),
        },
        applied: AppliedEdit {
            op: op.to_string(),
            pattern: ctx.pattern_src,
            matched_text: ctx.matched_text,
            new_text: text.to_string(),
            line: ctx.line,
            col: ctx.col,
            kind: ctx.kind,
        },
    })
}

fn build_delete_edit(nm: &GMatch, ctx: MatchContext) -> Result<PlannedEdit> {
    let edit = nm.remove();
    Ok(PlannedEdit {
        edit,
        applied: AppliedEdit {
            op: "delete".into(),
            pattern: ctx.pattern_src,
            matched_text: ctx.matched_text,
            new_text: String::new(),
            line: ctx.line,
            col: ctx.col,
            kind: ctx.kind,
        },
    })
}

/// Reject replacements that reference variables the pattern does not capture,
/// or capture with the wrong arity. Without this, ast-grep silently drops
/// unknown variables from the output (e.g. `$HOME` in a shell snippet).
fn check_replacement_vars(pattern_src: &str, replace: &str, label: &str) -> Result<()> {
    let pattern_vars = scan_vars(pattern_src);
    for (name, multi) in scan_vars(replace) {
        if name == "_" {
            bail!("{label}: replacement cannot reference `$_`")
        }
        match pattern_vars.iter().find(|(n, _)| n == &name) {
            Some((_, pm)) if pm == &multi => {}
            Some((_, pm)) => {
                // the sigil must match the PATTERN's arity, not the replacement's
                let sigil = if *pm { "$$$" } else { "$" };
                bail!(
                    "{label}: replacement references `{}{name}` but the pattern captures `{name}` as a {} — use `{sigil}{name}` in the replacement",
                    if multi { "$$$" } else { "$" },
                    if *pm { "list of nodes" } else { "single node" }
                );
            }
            None => {
                let defined = if pattern_vars.is_empty() {
                    "none".to_string()
                } else {
                    pattern_vars
                        .iter()
                        .map(|(n, m)| {
                            if *m {
                                format!("$$${n}")
                            } else {
                                format!("${n}")
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                bail!(
                    "{label}: replacement references `${name}` which is not captured by the pattern (pattern defines: {defined})"
                );
            }
        }
    }
    Ok(())
}

/// The replacement/insertion must parse as valid code on its own.
/// This is the first line of defense against unbalanced brackets and
/// partial fragments; the whole-file re-parse is the second.
fn validate_fragment(text: &str, lang: SupportLang) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    let ast = lang.ast_grep(text);
    let errors = collect_errors(&ast.root());
    if errors.is_empty() {
        Ok(())
    } else {
        bail!(
            "`{}` — {}",
            truncate(text, MAX_FRAGMENT_TEXT),
            errors[0].text
        )
    }
}

fn check_overlap(plan: &[PlannedEdit]) -> Result<()> {
    let mut sorted: Vec<&PlannedEdit> = plan.iter().collect();
    sorted.sort_by_key(|p| p.edit.position);
    for w in sorted.windows(2) {
        let a = &w[0].edit;
        let b = &w[1].edit;
        let a_end = a.position + a.deleted_length;
        if b.position < a_end
            || (b.position == a_end && a.deleted_length == 0 && b.deleted_length == 0)
        {
            bail!(
                "edits overlap or are ambiguous (two insertions at the same position). Merge them into one edit or target disjoint regions."
            );
        }
    }
    Ok(())
}

fn apply_text_edit(content: &mut String, edit: &Edit<String>) {
    let inserted = String::from_utf8_lossy(&edit.inserted_text).to_string();
    content.replace_range(
        edit.position..edit.position + edit.deleted_length,
        &inserted,
    );
}

/// Sort planned edits by position and apply them to a copy of the content in
/// reverse position order. Positions refer to the ORIGINAL text, so reverse
/// order keeps earlier positions valid regardless of input order.
fn apply_plan(content: &str, mut plan: Vec<PlannedEdit>) -> Result<(String, Vec<AppliedEdit>)> {
    plan.sort_by_key(|p| p.edit.position);
    let mut new_content = content.to_string();
    for pe in plan.iter().rev() {
        apply_text_edit(&mut new_content, &pe.edit);
    }
    if new_content == content {
        bail!("no changes made: the replacements produced identical content");
    }
    let applied: Vec<AppliedEdit> = plan.into_iter().map(|p| p.applied).collect();
    Ok((new_content, applied))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_edits(content: &str, path: &str, edits: Vec<EditSpec>) -> Result<EditResult> {
        let req = EditRequest {
            content: content.to_string(),
            edits,
        };
        match SupportLang::from_path(path) {
            Some(lang) => edit_structural(&req, lang),
            None => edit_exact(&req),
        }
    }

    fn pattern_edit(pattern: &str, replace: &str) -> EditSpec {
        EditSpec {
            pattern: Some(pattern.into()),
            replace: Some(replace.into()),
            insert_before: None,
            insert_after: None,
            delete: false,
            context: None,
            old_text: None,
            new_text: None,
            match_index: None,
            all: false,
        }
    }

    fn exact_edit(old_text: &str, new_text: &str) -> EditSpec {
        EditSpec {
            pattern: None,
            replace: None,
            insert_before: None,
            insert_after: None,
            delete: false,
            context: None,
            old_text: Some(old_text.into()),
            new_text: Some(new_text.into()),
            match_index: None,
            all: false,
        }
    }

    #[test]
    fn replace_with_var_keeps_semicolons() {
        let r = run_edits(
            "var a = 1; let b = 2;",
            "x.js",
            vec![pattern_edit("var $A = $B", "let $A = $B")],
        )
        .unwrap();
        assert_eq!(r.new_content, "let a = 1; let b = 2;");
        assert_eq!(r.applied.len(), 1);
        assert_eq!(r.applied[0].matched_text, "var a = 1;");
        assert_eq!(r.applied[0].new_text, "let a = 1");
    }

    #[test]
    fn whitespace_insensitive_match() {
        let mut spec = pattern_edit("foo($A, $B)", "bar($A, $B)");
        spec.all = true;
        let r = run_edits("foo(1,2);\nfoo( 3 , 4 );", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "bar(1, 2);\nbar(3, 4);");
    }

    #[test]
    fn invalid_replacement_rejected() {
        let err = run_edits(
            "let a = 1;",
            "x.js",
            vec![pattern_edit("let $A = $B", "let $A = ")],
        )
        .unwrap_err();
        assert!(err.to_string().contains("produces invalid code"), "{err}");
    }

    #[test]
    fn unbalanced_bracket_replacement_rejected() {
        let err = run_edits(
            "function f() { return 1; }",
            "x.js",
            vec![pattern_edit(
                "function f() { $$$BODY }",
                "function f() { $$$BODY",
            )],
        )
        .unwrap_err();
        assert!(err.to_string().contains("produces invalid code"), "{err}");
    }

    #[test]
    fn replacement_valid_alone_but_broken_in_context_rolled_back() {
        // "let y = 1" parses standalone, but inside "const x = ..." it breaks.
        let err = run_edits(
            "const x = foo(1);",
            "x.js",
            vec![pattern_edit("foo($A)", "let y = $A")],
        )
        .unwrap_err();
        assert!(err.to_string().contains("new syntax error"), "{err}");
        assert!(err.to_string().contains("rolled back"), "{err}");
    }

    #[test]
    fn multiple_matches_require_disambiguation() {
        let err = run_edits(
            "foo(1); foo(2);",
            "x.js",
            vec![pattern_edit("foo($A)", "bar($A)")],
        )
        .unwrap_err();
        assert!(err.to_string().contains("matches 2 nodes"), "{err}");
        assert!(err.to_string().contains("[0]"), "{err}");
        assert!(err.to_string().contains("[1]"), "{err}");

        let mut spec = pattern_edit("foo($A)", "bar($A)");
        spec.match_index = Some(1);
        let r = run_edits("foo(1); foo(2);", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "foo(1); bar(2);");

        let mut spec = pattern_edit("foo($A)", "bar($A)");
        spec.all = true;
        let r = run_edits("foo(1); foo(2);", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "bar(1); bar(2);");
    }

    #[test]
    fn insert_before_after() {
        let mut spec = pattern_edit("foo()", "");
        spec.replace = None;
        spec.insert_before = Some("bar();\n".into());
        let r = run_edits("foo();", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "bar();\nfoo();");

        // insertAfter lands after the trailing `;` of the statement
        let mut spec = pattern_edit("foo()", "");
        spec.replace = None;
        spec.insert_after = Some("bar();".into());
        let r = run_edits("foo();", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "foo();bar();");
    }

    #[test]
    fn delete_removes_whole_node() {
        // deleting the call expression leaves the statement's `;`
        let mut spec = pattern_edit("foo()", "");
        spec.replace = None;
        spec.delete = true;
        let r = run_edits("foo(); bar();", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "; bar();");

        // including the `;` in the pattern removes the whole statement
        let mut spec = pattern_edit("foo();", "");
        spec.replace = None;
        spec.delete = true;
        let r = run_edits("foo(); bar();", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, " bar();");
    }

    #[test]
    fn exact_mode_structural_match() {
        // oldText without semicolon matches the node with semicolon
        let r = run_edits(
            "const x = 1;",
            "x.js",
            vec![exact_edit("const x = 1", "const y = 2")],
        )
        .unwrap();
        assert_eq!(r.new_content, "const y = 2;");
    }

    #[test]
    fn exact_mode_falls_back_to_text_search() {
        // "= 5" is not a single AST node → plain text search
        let r = run_edits("let a = 5;", "x.js", vec![exact_edit("= 5", "= 6")]).unwrap();
        assert_eq!(r.new_content, "let a = 6;");
    }

    #[test]
    fn exact_mode_does_not_match_partial_tokens() {
        // "foo" as a pattern matches the identifier node, not "foobar"
        let r = run_edits("let foobar = foo;", "x.js", vec![exact_edit("foo", "bar")]).unwrap();
        assert_eq!(r.new_content, "let foobar = bar;");
    }

    #[test]
    fn unsupported_language_uses_exact_text() {
        let r = run_edits(
            "hello world foo",
            "x.txt",
            vec![exact_edit("world", "there")],
        )
        .unwrap();
        assert_eq!(r.new_content, "hello there foo");

        let err = run_edits("hello", "x.txt", vec![pattern_edit("hello", "bye")]).unwrap_err();
        assert!(
            err.to_string().contains("not supported by ast-grep"),
            "{err}"
        );
    }

    #[test]
    fn undefined_replacement_var_rejected() {
        let err = run_edits(
            "foo(1);",
            "x.js",
            vec![pattern_edit("foo($A)", "bar($A, $B)")],
        )
        .unwrap_err();
        assert!(err.to_string().contains("not captured"), "{err}");

        // arity mismatch: $$$A captured, $A referenced
        let err = run_edits(
            "function f() { a(); b(); }",
            "x.js",
            vec![pattern_edit(
                "function f() { $$$BODY }",
                "function f() { $BODY }",
            )],
        )
        .unwrap_err();
        assert!(err.to_string().contains("use `$$$BODY`"), "{err}");
    }

    #[test]
    fn context_restricts_matches() {
        let mut spec = pattern_edit("foo($A)", "bar($A)");
        spec.context = Some("function a() { $$$ }".into());
        let r = run_edits(
            "function a() { foo(1); }\nfunction b() { foo(2); }",
            "x.js",
            vec![spec],
        )
        .unwrap();
        assert_eq!(
            r.new_content,
            "function a() { bar(1); }\nfunction b() { foo(2); }"
        );
    }

    #[test]
    fn overlapping_edits_rejected() {
        // both edits target the same node via matchIndex 0
        let mut a = pattern_edit("foo($A)", "bar($A)");
        a.match_index = Some(0);
        let mut b = pattern_edit("foo($A)", "baz($A)");
        b.match_index = Some(0);
        let err = run_edits("foo(1); foo(2);", "x.js", vec![a, b]).unwrap_err();
        assert!(err.to_string().contains("overlap"), "{err}");
    }

    #[test]
    fn edits_applied_in_position_order_not_input_order() {
        // input order is descending by position; the second edit's length
        // change must not shift the first edit's position
        let mut later = pattern_edit("foo(2)", "baz(2, 3)"); // position 9, len 5 -> 9
        let mut earlier = pattern_edit("foo(1)", "bar(1)"); // position 0, len 5 -> 5
        later.match_index = Some(0);
        earlier.match_index = Some(0);
        let r = run_edits("foo(1); foo(2);", "x.js", vec![later, earlier]).unwrap();
        assert_eq!(r.new_content, "bar(1); baz(2, 3);");
    }

    #[test]
    fn no_change_rejected() {
        let err =
            run_edits("foo(1);", "x.js", vec![pattern_edit("foo($A)", "foo($A)")]).unwrap_err();
        assert!(err.to_string().contains("no changes"), "{err}");
    }

    #[test]
    fn preexisting_errors_reported_but_edit_proceeds() {
        // file already broken; a valid edit that does not add errors is allowed
        let r = run_edits(
            "foo(1);\nlet = ;",
            "x.js",
            vec![pattern_edit("foo($A)", "bar($A)")],
        )
        .unwrap();
        assert_eq!(r.new_content, "bar(1);\nlet = ;");
        assert_eq!(r.pre_errors.len(), 1);
        assert_eq!(r.post_errors.len(), 1);
    }

    #[test]
    fn match_index_out_of_range_rejected() {
        let mut spec = pattern_edit("foo($A)", "bar($A)");
        spec.match_index = Some(9); // only 2 matches exist
        let err = run_edits("foo(1); foo(2);", "x.js", vec![spec]).unwrap_err();
        assert!(err.to_string().contains("out of range"), "{err}");
    }

    #[test]
    fn multi_capture_substitution() {
        let r = run_edits(
            "function f(a, b) { return a + b; }",
            "x.js",
            vec![pattern_edit(
                "function f($$$ARGS) { $$$BODY }",
                "function g($$$ARGS) { $$$BODY }",
            )],
        )
        .unwrap();
        assert_eq!(r.new_content, "function g(a, b) { return a + b; }");
    }

    #[test]
    fn nested_matches_edit_outer_only() {
        // replace_all semantics: a matched node's descendants are not matched
        let mut spec = pattern_edit("Some($A)", "$A");
        spec.all = true;
        let r = run_edits("Some(Some(1))", "x.ts", vec![spec]).unwrap();
        assert_eq!(r.new_content, "Some(1)");
    }

    #[test]
    fn insert_after_argument_without_separator_is_rejected() {
        // the `,` after the matched number is skipped, but inserting bare `x`
        // before the following ` 2` still breaks syntax (`x 2` has no
        // separator) — the rollback guard must reject it, not write broken code
        let mut spec = pattern_edit("1", "");
        spec.replace = None;
        spec.insert_after = Some("x".into());
        let err = run_edits("f(1, 2);", "x.js", vec![spec]).unwrap_err();
        assert!(err.to_string().contains("rolled back"), "{err}");

        // a separator-only fragment is not valid standalone code either,
        // so the fragment validation rejects it — the clean way is replace
        let mut spec = pattern_edit("1", "");
        spec.replace = None;
        spec.insert_after = Some("x, ".into());
        let err = run_edits("f(1, 2);", "x.js", vec![spec]).unwrap_err();
        assert!(err.to_string().contains("not valid code"), "{err}");

        let r = run_edits(
            "f(1, 2);",
            "x.js",
            vec![pattern_edit("f($A, $B)", "f($A, x, $B)")],
        )
        .unwrap();
        assert_eq!(r.new_content, "f(1, x, 2);");
    }

    #[test]
    fn unicode_identifiers_and_byte_positions() {
        // multibyte identifiers must not corrupt byte-based edit positions
        let mut spec = pattern_edit("let $A = $B", "let $A = 0");
        spec.all = true;
        let r = run_edits("let 你好 = 1;\nlet 世界 = 2;", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "let 你好 = 0;\nlet 世界 = 0;");
        assert_eq!(r.applied[0].line, 1);
        assert_eq!(r.applied[1].line, 2);
        assert_eq!(r.applied[1].col, 1);
    }

    #[test]
    fn exact_match_at_file_boundaries() {
        // oldText at the very start of the file
        let r = run_edits("foo();", "x.js", vec![exact_edit("foo", "bar")]).unwrap();
        assert_eq!(r.new_content, "bar();");
        // oldText at the very end (no trailing newline)
        let r = run_edits("let x = 1", "x.js", vec![exact_edit("1", "2")]).unwrap();
        assert_eq!(r.new_content, "let x = 2");
    }

    #[test]
    fn empty_content_rejected() {
        let err = run_edits("", "x.js", vec![pattern_edit("foo", "bar")]).unwrap_err();
        assert!(err.to_string().contains("matched nothing"), "{err}");
        let err = run_edits("", "x.js", vec![exact_edit("foo", "bar")]).unwrap_err();
        assert!(
            err.to_string().contains("could not find the exact text"),
            "{err}"
        );
    }

    #[test]
    fn delete_all_removes_every_match() {
        let mut spec = pattern_edit("foo();", "");
        spec.replace = None;
        spec.delete = true;
        spec.all = true;
        let r = run_edits("foo();\nfoo();", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "\n");
    }

    #[test]
    fn insert_before_all_matches() {
        let mut spec = pattern_edit("foo()", "");
        spec.replace = None;
        spec.insert_before = Some("bar();".into());
        spec.all = true;
        let r = run_edits("foo();\nfoo();", "x.js", vec![spec]).unwrap();
        assert_eq!(r.new_content, "bar();foo();\nbar();foo();");
    }

    #[test]
    fn exact_mode_with_context() {
        let mut spec = exact_edit("foo(1)", "bar(1)");
        spec.context = Some("function a() { $$$ }".into());
        let r = run_edits(
            "function a() { foo(1); }\nfunction b() { foo(2); }",
            "x.js",
            vec![spec],
        )
        .unwrap();
        assert_eq!(
            r.new_content,
            "function a() { bar(1); }\nfunction b() { foo(2); }"
        );
    }
}
