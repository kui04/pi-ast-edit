use anyhow::{Context, Result, bail};
use ast_grep_core::matcher::{KindMatcher, Matcher, MatcherExt};
use ast_grep_core::tree_sitter::StrDoc;
use ast_grep_core::{Node, NodeMatch, Pattern};
use ast_grep_language::SupportLang;

use crate::protocol::{NodeInfo, SyntaxError};

/// Truncation limits for text reported to the agent.
pub const MAX_ERROR_TEXT: usize = 120;
pub const MAX_MATCH_TEXT: usize = 200;
pub const MAX_SNIPPET: usize = 80;
pub const MAX_FRAGMENT_TEXT: usize = 60;

pub type Doc = StrDoc<SupportLang>;
pub type GNode<'r> = Node<'r, Doc>;
pub type GMatch<'r> = NodeMatch<'r, Doc>;

pub fn get_arg(args: &[String], name: &str) -> Result<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it
                .next()
                .cloned()
                .with_context(|| format!("missing value for {name}"));
        }
    }
    bail!("missing required option {name}");
}

pub fn get_opt(args: &[String], name: &str) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().cloned();
        }
    }
    None
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().take(max + 1).count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

/// All ERROR and MISSING nodes in the tree — these are syntax errors.
/// MISSING nodes are tree-sitter's way of reporting absent required tokens
/// (e.g. an unclosed `{` produces a missing `}`); without them, edits that
/// drop a closing bracket would pass the syntax check.
pub fn collect_errors(root: &GNode) -> Vec<SyntaxError> {
    let mut errors: Vec<SyntaxError> = root
        .find_all(KindMatcher::error_matcher())
        .map(|nm| SyntaxError {
            line: nm.start_pos().line() + 1,
            col: nm.start_pos().column(&nm) + 1,
            text: truncate(&nm.text(), MAX_ERROR_TEXT),
        })
        .collect();
    for n in root.dfs().filter(Node::is_missing) {
        errors.push(SyntaxError {
            line: n.start_pos().line() + 1,
            col: n.start_pos().column(&n) + 1,
            text: format!("missing `{}`", n.kind()),
        });
    }
    errors
}

pub fn format_errors(errors: &[SyntaxError]) -> String {
    errors
        .iter()
        .map(|e| format!("  line {}, col {}: {}", e.line, e.col, e.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Collect matches without nested matches: once a node matches, its
/// descendants are skipped. Same semantics as ast-grep's `replace_all`, so the
/// match list an edit reports is exactly what `all: true` would edit.
pub fn find_non_nested<'r>(root: &GNode<'r>, matcher: &impl Matcher) -> Vec<GMatch<'r>> {
    let mut out = Vec::new();
    let mut skip_until: Option<usize> = None;
    for node in root.dfs() {
        if let Some(end) = skip_until {
            if node.range().start < end {
                continue;
            }
            skip_until = None;
        }
        if let Some(nm) = matcher.match_node(node) {
            skip_until = Some(nm.range().end);
            out.push(nm);
        }
    }
    out
}

/// Keep only matches inside the context pattern, if any.
pub fn filter_context<'r>(matches: Vec<GMatch<'r>>, ctx: &Option<Pattern>) -> Vec<GMatch<'r>> {
    match ctx {
        Some(c) => matches.into_iter().filter(|nm| nm.inside(c)).collect(),
        None => matches,
    }
}

/// 1-based line:col (character columns) → byte offset.
pub fn line_col_to_offset(content: &str, line: usize, col: usize) -> Result<usize> {
    let mut line_start = 0usize;
    let mut current = 1usize;
    for (i, b) in content.bytes().enumerate() {
        if current == line {
            let rest = &content[line_start..];
            let char_col = rest.chars().count();
            let col = col.saturating_sub(1).min(char_col);
            let offset = rest.char_indices().nth(col).map_or(rest.len(), |(i, _)| i);
            return Ok(line_start + offset);
        }
        if b == b'\n' {
            current += 1;
            line_start = i + 1;
        }
    }
    if current == line {
        return Ok(content.len());
    }
    bail!("position {line}:{col} is outside the file");
}

/// 0-based line of a byte offset.
#[expect(
    clippy::naive_bytecount,
    reason = "offsets are small; a bytecount dep is not worth it"
)]
pub fn line_of(content: &str, offset: usize) -> usize {
    content.as_bytes()[..offset.min(content.len())]
        .iter()
        .filter(|&&b| b == b'\n')
        .count()
}

/// 0-based character column of a byte offset.
pub fn col_of(content: &str, offset: usize) -> usize {
    let offset = offset.min(content.len());
    let line_start = content.as_bytes()[..offset]
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |i| i + 1);
    content[line_start..offset].chars().count()
}

/// Smallest named node whose range contains `offset` (inclusive end).
/// Ties on range length go to the deeper node (later in pre-order).
pub fn node_at_offset<'r>(root: &GNode<'r>, offset: usize) -> Option<GNode<'r>> {
    let mut best: Option<GNode<'r>> = None;
    for n in root.dfs() {
        if !n.is_named() || n.range().start > offset || offset > n.range().end {
            continue;
        }
        match &best {
            Some(b) if n.range().len() > b.range().len() => {}
            _ => best = Some(n),
        }
    }
    best
}

pub fn node_info(n: &GNode<'_>) -> NodeInfo {
    NodeInfo {
        kind: n.kind().to_string(),
        line: n.start_pos().line() + 1,
        col: n.start_pos().column(n) + 1,
        end_line: n.end_pos().line() + 1,
        end_col: n.end_pos().column(n) + 1,
        text: truncate(&n.text(), MAX_MATCH_TEXT),
    }
}

/// Scan `$A` / `$$$A` style meta variables in a pattern or replacement source.
/// Returns `(name, is_multi)`. `$$A` counts as single, matching ast-grep.
pub fn scan_vars(src: &str) -> Vec<(String, bool)> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '$' {
            i += 1;
            continue;
        }
        let mut j = i;
        let mut dollars = 0;
        while j < chars.len() && chars[j] == '$' {
            dollars += 1;
            j += 1;
        }
        let start = j;
        while j < chars.len()
            && (chars[j].is_ascii_uppercase()
                || chars[j] == '_'
                || (j > start && chars[j].is_ascii_digit()))
        {
            j += 1;
        }
        if j > start {
            let name: String = chars[start..j].iter().collect();
            out.push((name, dollars >= 3));
            i = j;
        } else {
            i = j;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_vars() {
        assert_eq!(scan_vars("$A"), vec![("A".to_string(), false)]);
        assert_eq!(scan_vars("$$$A"), vec![("A".to_string(), true)]);
        assert_eq!(
            scan_vars("foo($A, $$$B)"),
            vec![("A".to_string(), false), ("B".to_string(), true)]
        );
        // lowercase and ${...} are not meta vars
        assert!(scan_vars("$home").is_empty());
        assert!(scan_vars("${x}").is_empty());
        // uppercase IS a meta var name, matching ast-grep
        assert_eq!(scan_vars("$HOME"), vec![("HOME".to_string(), false)]);        
        assert_eq!(scan_vars("$MY_VAR"), vec![("MY_VAR".to_string(), false)]);
        assert_eq!(scan_vars("$VAR1"), vec![("VAR1".to_string(), false)]);
        assert_eq!(scan_vars("$A$B"), vec![("A".to_string(), false), ("B".to_string(), false)]);
        // anonymous ellipsis has no name
        assert!(scan_vars("foo($$$)").is_empty());
    }

    #[test]
    fn test_line_col_roundtrip() {
        let content = "ab\ncd\nef";
        assert_eq!(line_col_to_offset(content, 1, 1).unwrap(), 0);
        assert_eq!(line_col_to_offset(content, 2, 1).unwrap(), 3);
        assert_eq!(line_col_to_offset(content, 2, 2).unwrap(), 4);
        assert_eq!(line_col_to_offset(content, 3, 3).unwrap(), 8);
        // col beyond line end clamps to line end
        assert_eq!(line_col_to_offset(content, 3, 99).unwrap(), 8);
        assert!(line_col_to_offset(content, 9, 1).is_err());
        assert_eq!(line_of(content, 4), 1);
        assert_eq!(col_of(content, 4), 1);
    }

    #[test]
    fn test_col_of_unicode() {
        // columns are character counts, not bytes; offsets must be
        // char boundaries (as match_indices always yields)
        let content = "你好x"; // 你 0..3, 好 3..6, x 6..7
        assert_eq!(col_of(content, 0), 0);
        assert_eq!(col_of(content, 6), 2); // byte 6 is `x`
        assert_eq!(col_of(content, 7), 3);
        assert_eq!(col_of("a\n你好", 5), 1); // after `\n`, byte 5 starts `好`
        assert_eq!(col_of("a\n你好", 8), 2);
    }

    #[test]
    fn test_truncate() {
        assert_eq!(truncate("abc", 3), "abc");
        assert_eq!(truncate("abcd", 3), "abc…");
        assert_eq!(truncate("", 3), "");
    }
}
