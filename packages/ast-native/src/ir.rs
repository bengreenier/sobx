//! The sobx IR (mirrors `packages/ast/src/types.ts`). Serialized to JSON for JS consumers.
//!
//! SPIKE: only the parts produced by the ported slice are modeled.

use serde::Serialize;
use serde_json::{Map, Value};

pub const IR_VERSION: u32 = 3;

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Loc {
    pub start: Position,
    pub end: Position,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
    pub loc: Loc,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub kind: &'static str,
    pub ir_version: u32,
    pub filename: Option<String>,
    pub module_specifier: String,
    pub imports: Vec<Import>,
    pub observables: Vec<Observable>,
    pub computeds: Vec<Value>,
    pub accesses: Vec<Access>,
    pub reactions: Vec<Reaction>,
    pub actions: Vec<Value>,
    pub unsupported: Vec<UnsupportedUsage>,
    pub diagnostics: Vec<Diagnostic>,
}

// Variant names are the IR's JSON `kind` tags.
#[allow(clippy::enum_variant_names)]
#[derive(Serialize)]
#[serde(tag = "kind")]
pub enum Import {
    NamedImport {
        imported: String,
        local: String,
        api: Option<&'static str>,
        span: Span,
    },
    NamespaceImport {
        local: String,
        span: Span,
    },
    DefaultImport {
        local: String,
        span: Span,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub name: String,
    pub scope: &'static str,
    pub declaration_kind: &'static str,
    pub exported: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Annotation {
    #[serde(rename = "observable")]
    Observable { modifier: &'static str },
    #[serde(rename = "computed")]
    Computed { modifier: &'static str },
    #[serde(rename = "autoAction")]
    AutoAction { bound: bool },
    #[serde(rename = "flow")]
    Flow { bound: bool },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub key: String,
    pub member_kind: &'static str,
    pub value_kind: &'static str,
    #[serde(rename = "static")]
    pub is_static: bool,
    pub accessor: bool,
    pub annotation: Option<Annotation>,
    pub annotation_source: Option<&'static str>,
    pub computed: Option<String>,
    pub action: Option<String>,
    pub span: Span,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Shape {
    #[serde(rename = "object")]
    Object { members: Vec<Member>, open: bool },
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observable {
    pub kind: &'static str,
    pub id: String,
    pub source: &'static str,
    pub target: &'static str,
    pub binding: Option<Binding>,
    pub shape: Shape,
    pub options: Option<Options>,
    pub span: Span,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Options {
    #[serde(rename = "object")]
    Object { entries: Map<String, Value>, open: bool },
    #[serde(rename = "unknown")]
    Unknown { span: Span },
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(tag = "kind")]
pub enum AccessKey {
    #[serde(rename = "static")]
    Static { name: String },
    #[serde(rename = "dynamic")]
    Dynamic,
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Context {
    Untracked,
    Tracked { by: String },
    TrackedNested { by: String },
    Effect { reaction: String },
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
pub enum Access {
    Read {
        id: String,
        observable: String,
        key: AccessKey,
        receiver: &'static str,
        context: Context,
        span: Span,
        via: &'static str,
        path: Vec<AccessKey>,
        called: bool,
    },
    Write {
        id: String,
        observable: String,
        key: AccessKey,
        receiver: &'static str,
        context: Context,
        span: Span,
        operator: String,
        #[serde(rename = "readsPrevious")]
        reads_previous: bool,
    },
    Delete {
        id: String,
        observable: String,
        key: AccessKey,
        receiver: &'static str,
        context: Context,
        span: Span,
    },
}

impl Access {
    pub fn span(&self) -> Span {
        match self {
            Access::Read { span, .. } | Access::Write { span, .. } | Access::Delete { span, .. } => {
                *span
            }
        }
    }
    pub fn context(&self) -> &Context {
        match self {
            Access::Read { context, .. }
            | Access::Write { context, .. }
            | Access::Delete { context, .. } => context,
        }
    }
    pub fn observable(&self) -> &str {
        match self {
            Access::Read { observable, .. }
            | Access::Write { observable, .. }
            | Access::Delete { observable, .. } => observable,
        }
    }
    pub fn set_id(&mut self, value: String) {
        match self {
            Access::Read { id, .. } | Access::Write { id, .. } | Access::Delete { id, .. } => {
                *id = value
            }
        }
    }
    pub fn id(&self) -> &str {
        match self {
            Access::Read { id, .. } | Access::Write { id, .. } | Access::Delete { id, .. } => id,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FunctionRef {
    #[serde(rename = "inline")]
    Inline { params: u32, #[serde(rename = "async")] is_async: bool, span: Span },
    #[serde(rename = "opaque")]
    Opaque { span: Span },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub kind: &'static str,
    pub id: String,
    pub api: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<FunctionRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<FunctionRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<FunctionRef>,
    pub options: Option<Options>,
    pub dependencies: Vec<String>,
    pub indirect_dependencies: Vec<String>,
    pub disposer_used: bool,
    pub span: Span,
}

#[derive(Serialize)]
pub struct UnsupportedUsage {
    pub kind: &'static str,
    pub api: Option<&'static str>,
    pub local: String,
    pub span: Span,
}

#[derive(Serialize)]
pub struct Diagnostic {
    pub kind: &'static str,
    pub code: &'static str,
    pub severity: &'static str,
    pub message: String,
    pub span: Span,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<String>,
}
