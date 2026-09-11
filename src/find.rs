use anyhow::{Context, Result, bail};
use ast_grep_core::Pattern;
use ast_grep_core::matcher::KindMatcher;
use ast_grep_core::meta_var::MetaVariable;
use ast_grep_language::{Language, LanguageExt, SupportLang};
use serde_json::Value;

use crate::protocol::{FindMatch, FindResult, PositionResult, VarValue};
use crate::util::{
    GMatch, MAX_MATCH_TEXT, MAX_SNIPPET, collect_errors, filter_context, find_non_nested, get_arg,
    get_opt, line_col_to_offset, node_at_offset, node_info, truncate,
};

/// Default cap on reported matches.
pub const DEFAULT_LIMIT: usize = 20;

pub fn run(args: &[String]) -> Result<Value> {
    let path = get_arg(args, "--path")?;
    let pattern = get_opt(args, "--pattern");
    let context = get_opt(args, "--context");
    let kind = get_opt(args, "--kind");
    let position = get_opt(args, "--position");
    let limit = get_opt(args, "--limit")
        .map(|s| {
            s.parse::<usize>()
                .with_context(|| format!("invalid --limit `{s}`"))
        })
        .transpose()?
        .unwrap_or(DEFAULT_LIMIT);
    let lang = SupportLang::from_path(&path)
        .with_context(|| format!("unsupported language for `{path}`"))?;
    let source =
        std::fs::read_to_string(&path).with_context(|| format!("failed to read `{path}`"))?;
    let ast = lang.ast_grep(&source);
    let root = ast.root();
    let errors = collect_errors(&root);

    if let Some(pos) = position {
        let (line, col) = parse_position(&pos)?;
        let offset = line_col_to_offset(&source, line, col)?;
        let node =
            node_at_offset(&root, offset).with_context(|| format!("no node at {line}:{col}"))?;
        let mut ancestors = Vec::new();
        let mut cur = node.parent();
        while let Some(n) = cur {
            ancestors.push(node_info(&n));
            cur = n.parent();
        }
        tracing::info!(path = %path, position = %pos, "node at position");
        return Ok(serde_json::to_value(PositionResult {
            language: lang.to_string(),
            node: node_info(&node),
            ancestors,
            errors,
        })?);
    }

    let pat: Option<Pattern> = pattern
        .as_deref()
        .map(|p| {
            let pat =
                Pattern::try_new(p, lang).with_context(|| format!("invalid pattern `{p}`"))?;
            if pat.has_error() {
                bail!("pattern `{p}` is not valid syntax");
            }
            Ok(pat)
        })
        .transpose()?;
    let matches: Vec<GMatch> = match (&pat, &kind) {
        (Some(pat), Some(k)) => find_non_nested(&root, pat)
            .into_iter()
            .filter(|nm| nm.kind() == *k)
            .collect(),
        (Some(pat), None) => find_non_nested(&root, pat),
        (None, Some(k)) => {
            let km =
                KindMatcher::try_new(k, lang).with_context(|| format!("invalid kind `{k}`"))?;
            find_non_nested(&root, &km)
        }
        (None, None) => bail!("specify --pattern, --kind, or --position"),
    };

    let ctx = match &context {
        Some(c) => {
            Some(Pattern::try_new(c, lang).with_context(|| format!("invalid context `{c}`"))?)
        }
        None => None,
    };
    let matches: Vec<FindMatch> = filter_context(matches, &ctx)
        .into_iter()
        .take(limit)
        .map(|nm| to_find_match(&nm, &source))
        .collect();

    tracing::info!(path = %path, matches = matches.len(), "find done");
    Ok(serde_json::to_value(FindResult {
        language: lang.to_string(),
        matches,
        errors,
    })?)
}

fn to_find_match(nm: &GMatch, source: &str) -> FindMatch {
    let mut vars = Vec::new();
    for mv in nm.get_env().get_matched_variables() {
        let name = match &mv {
            MetaVariable::Capture(n, _) | MetaVariable::MultiCapture(n) => n.clone(),
            _ => continue,
        };
        if let Some(node) = nm.get_env().get_match(&name) {
            vars.push(VarValue {
                name,
                text: truncate(&node.text(), MAX_SNIPPET),
            });
        } else {
            let nodes = nm.get_env().get_multiple_matches(&name);
            if !nodes.is_empty() {
                let text = nodes
                    .iter()
                    .map(|n| n.text().to_string())
                    .collect::<Vec<_>>()
                    .join(" ");
                vars.push(VarValue {
                    name,
                    text: truncate(&text, MAX_SNIPPET),
                });
            }
        }
    }
    FindMatch {
        line: nm.start_pos().line() + 1,
        col: nm.start_pos().column(nm) + 1,
        end_line: nm.end_pos().line() + 1,
        end_col: nm.end_pos().column(nm) + 1,
        kind: nm.kind().to_string(),
        text: truncate(&nm.text(), MAX_MATCH_TEXT),
        vars,
        line_text: truncate(
            source.lines().nth(nm.start_pos().line()).unwrap_or(""),
            MAX_MATCH_TEXT,
        ),
    }
}

fn parse_position(s: &str) -> Result<(usize, usize)> {
    let (l, c) = s
        .split_once(':')
        .with_context(|| format!("invalid position `{s}`, expected line:col"))?;
    let line = l
        .parse::<usize>()
        .with_context(|| format!("invalid line in position `{s}`"))?;
    let col = c
        .parse::<usize>()
        .with_context(|| format!("invalid col in position `{s}`"))?;
    if line == 0 || col == 0 {
        bail!("position `{s}` is 1-based; line and col must be >= 1");
    }
    Ok((line, col))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_position() {
        assert_eq!(parse_position("3:5").unwrap(), (3, 5));
        assert!(parse_position("0:5").is_err());
        assert!(parse_position("3").is_err());
        assert!(parse_position("a:b").is_err());
    }

    #[test]
    fn test_node_at_offset() {
        let lang = SupportLang::TypeScript;
        let ast = lang.ast_grep("let a = 1;");
        let root = ast.root();
        // offset 4 is inside the identifier `a`
        let node = node_at_offset(&root, 4).unwrap();
        assert_eq!(node.kind(), "identifier");
        assert_eq!(node.text(), "a");
        // offset 0 is the start of the declaration
        let node = node_at_offset(&root, 0).unwrap();
        assert_eq!(node.kind(), "lexical_declaration");
    }

    #[test]
    fn test_node_at_offset_unicode() {
        let lang = SupportLang::TypeScript;
        let ast = lang.ast_grep("let 你好 = 1;");
        let root = ast.root();
        // byte 4 is the start of `你好` (2 × 3 bytes)
        let node = node_at_offset(&root, 4).unwrap();
        assert_eq!(node.kind(), "identifier");
        assert_eq!(node.text(), "你好");
    }
}
