use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxError {
    pub line: usize,
    pub col: usize,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    pub content: String,
    pub edits: Vec<EditSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSpec {
    pub pattern: Option<String>,
    pub replace: Option<String>,
    pub insert_before: Option<String>,
    pub insert_after: Option<String>,
    #[serde(default)]
    pub delete: bool,
    pub context: Option<String>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub match_index: Option<usize>,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub new_content: String,
    pub applied: Vec<AppliedEdit>,
    pub pre_errors: Vec<SyntaxError>,
    pub post_errors: Vec<SyntaxError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedEdit {
    /// `replace` | `insert_before` | `insert_after` | `delete`
    pub op: String,
    /// the pattern or oldText that was matched
    pub pattern: String,
    pub matched_text: String,
    pub new_text: String,
    pub line: usize,
    pub col: usize,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub language: String,
    pub matches: Vec<FindMatch>,
    pub errors: Vec<SyntaxError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindMatch {
    pub line: usize,
    pub col: usize,
    pub end_line: usize,
    pub end_col: usize,
    pub kind: String,
    pub text: String,
    pub vars: Vec<VarValue>,
    pub line_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VarValue {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub kind: String,
    pub line: usize,
    pub col: usize,
    pub end_line: usize,
    pub end_col: usize,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionResult {
    pub language: String,
    pub node: NodeInfo,
    pub ancestors: Vec<NodeInfo>,
    pub errors: Vec<SyntaxError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    pub name: String,
    pub extensions: Vec<String>,
}
