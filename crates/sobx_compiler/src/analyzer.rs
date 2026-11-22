//! The sobx analyzer, built on oxc_parser + oxc_semantic. Produces the IR described by
//! `@sobx/ast` (`packages/ast/src/types.ts`).

use std::collections::{HashMap, HashSet};

use oxc_ast::{AstKind, ast::*};
use oxc_semantic::{AstNodes, NodeId, Scoping, Semantic, SymbolId};
use oxc_span::GetSpan;
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator, UnaryOperator};
use serde_json::{Map, Value, json};

use crate::ir::{
    self, AccessKey, ActionSource, Annotation, Binding, ComputedSource, Context, FunctionRef, Member, Options,
    Shape, Target,
};

const MODELED: &[&str] = &[
    "action",
    "autorun",
    "computed",
    "flow",
    "makeAutoObservable",
    "makeObservable",
    "observable",
    "reaction",
    "runInAction",
    "when",
];
/// Recognized APIs whose uses are not analyzed (none at the moment).
const UNMODELED: &[&str] = &[];
/// Plain values (not calls) that are recognized and allowed anywhere.
const VALUES: &[&str] = &[
    "$mobx",
    "FlowCancellationError",
    "ObservableMap",
    "ObservableSet",
    "Reaction",
    "_allowStateChanges",
    "_allowStateChangesInsideComputed",
    "_allowStateReadsEnd",
    "_allowStateReadsStart",
    "_autoAction",
    "_endAction",
    "_getAdministration",
    "_getGlobalState",
    "_interceptReads",
    "_isComputingDerivation",
    "_resetGlobalState",
    "_startAction",
    "comparer",
    "configure",
    "createAtom",
    "defineProperty",
    "entries",
    "extendObservable",
    "flowResult",
    "get",
    "getAtom",
    "getDebugName",
    "getDependencyTree",
    "getObserverTree",
    "has",
    "intercept",
    "isAction",
    "isBoxedObservable",
    "isComputed",
    "isComputedProp",
    "isFlow",
    "isFlowCancellationError",
    "isObservable",
    "isObservableArray",
    "isObservableMap",
    "isObservableObject",
    "isObservableProp",
    "isObservableSet",
    "keys",
    "observe",
    "onBecomeObserved",
    "onBecomeUnobserved",
    "onReactionError",
    "override",
    "ownKeys",
    "remove",
    "set",
    "spy",
    "toJS",
    "trace",
    "transaction",
    "untracked",
    "values",
];
/// `observable.<kind>(...)` constructors.
const OBSERVABLE_VALUES: &[&str] = &["array", "box", "map", "set"];
/// Other members of the API's functions (annotations, and what is not analyzed): known, and usable
/// as any value.
const API_MEMBERS: &[(&str, &[&str])] = &[
    ("observable", &["ref", "shallow", "struct", "deep", "object"]),
    ("computed", &["struct"]),
    ("action", &["bound"]),
    ("flow", &["bound"]),
];
const ANNOTATING: &[&str] = &["observable", "makeObservable", "makeAutoObservable"];
const OBJECT_ENUMERATORS: &[&str] = &["keys", "values", "entries", "assign", "getOwnPropertyNames", "freeze"];
const MUTATING_ARRAY_METHODS: &[&str] =
    &["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"];

fn known_api(name: &str) -> Option<&'static str> {
    MODELED.iter().chain(UNMODELED.iter()).chain(VALUES.iter()).find(|api| **api == name).copied()
}

/// The role a function plays, which determines the context of accesses inside it.
#[derive(Clone)]
enum Role {
    Tracked(String),
    Effect(String),
    Action(String),
}

/// A member's value: a method/getter function, or a field initializer.
#[derive(Clone, Copy)]
enum Value_<'a> {
    Method(&'a Function<'a>),
    Expr(&'a Expression<'a>),
}

struct RawMember<'a> {
    key: String,
    member_kind: &'static str,
    value_kind: &'static str,
    is_static: bool,
    accessor: bool,
    value: Option<Value_<'a>>,
    decorators: Vec<&'a Decorator<'a>>,
    span: ir::Span,
}

#[derive(Clone)]
enum Written {
    Infer,
    Annotation(Annotation),
}

struct Explicit {
    entries: Vec<(String, Written, ir::Span)>,
}

impl Explicit {
    fn get(&self, key: &str) -> Option<&Written> {
        // Later duplicates win, as with a JS Map built in order.
        self.entries.iter().rev().find(|(k, _, _)| k == key).map(|(_, w, _)| w)
    }
}

#[derive(Clone, Copy)]
struct Defaults {
    auto_bind: bool,
    deep: bool,
}

/// Per-function facts, gathered in one pass over the nodes.
#[derive(Default)]
struct FnInfo {
    awaits: Vec<oxc_span::Span>,
    for_await_right_ends: Vec<u32>,
    calls: Vec<NodeId>,
    identifiers: Vec<NodeId>,
}

pub struct Analyzer<'s, 'a> {
    program: &'a Program<'a>,
    nodes: &'s AstNodes<'a>,
    scoping: &'s Scoping,
    module_specifier: String,
    filename: Option<String>,
    utf16: Vec<u32>,
    line_starts: Vec<u32>,

    imports: Vec<ir::Import>,
    observables: Vec<ir::Observable>,
    computeds: Vec<ir::Computed>,
    reactions: Vec<ir::Reaction>,
    actions: Vec<ir::Action>,
    unsupported: Vec<ir::UnsupportedUsage>,
    diagnostics: Vec<ir::Diagnostic>,
    pending: Vec<ir::Access>,
    pending_fns: Vec<Option<NodeId>>,

    api_refs: HashMap<NodeId, &'static str>,
    calls: HashMap<&'static str, Vec<NodeId>>,
    roles: HashMap<NodeId, Role>,
    role_order: Vec<NodeId>,
    action_calls: HashMap<NodeId, String>,
    observable_symbols: Vec<(SymbolId, String)>,
    symbol_observable: HashMap<SymbolId, String>,
    computed_symbols: Vec<(SymbolId, String)>,
    this_owners: HashMap<NodeId, String>,
    make_targets: HashSet<NodeId>,
    decorator_refs: Vec<NodeId>,
    /// Class node -> (index into `observables`, class symbol).
    classes: HashMap<NodeId, (usize, Option<SymbolId>)>,
    class_order: Vec<NodeId>,
    reported: HashSet<NodeId>,
    member_fns: HashMap<String, (NodeId, bool)>,
    fn_info: HashMap<NodeId, FnInfo>,
}

impl<'s, 'a> Analyzer<'s, 'a> {
    pub fn new(
        source: &'a str,
        program: &'a Program<'a>,
        semantic: &'s Semantic<'a>,
        module_specifier: String,
        filename: Option<String>,
    ) -> Self {
        let (utf16, line_starts) = utf16_index(source);
        Self {
            program,
            nodes: semantic.nodes(),
            scoping: semantic.scoping(),
            module_specifier,
            filename,
            utf16,
            line_starts,
            imports: vec![],
            observables: vec![],
            computeds: vec![],
            reactions: vec![],
            actions: vec![],
            unsupported: vec![],
            diagnostics: vec![],
            pending: vec![],
            pending_fns: vec![],
            api_refs: HashMap::new(),
            calls: HashMap::new(),
            roles: HashMap::new(),
            role_order: vec![],
            action_calls: HashMap::new(),
            observable_symbols: vec![],
            symbol_observable: HashMap::new(),
            computed_symbols: vec![],
            this_owners: HashMap::new(),
            make_targets: HashSet::new(),
            decorator_refs: vec![],
            classes: HashMap::new(),
            class_order: vec![],
            reported: HashSet::new(),
            member_fns: HashMap::new(),
            fn_info: HashMap::new(),
        }
    }

    pub fn run(mut self) -> ir::Module {
        self.index_functions();
        self.collect_imports();

        // action() calls first, so observable members holding them can link to them.
        for call in self.sorted(&["action", "flow"]) {
            if self.callee_api(call) == Some("flow") {
                self.visit_flow_call(call);
            } else {
                self.visit_action_call(call);
            }
        }
        // Observables, including their getters / methods.
        for call in self.sorted(&[
            "observable",
            "makeObservable",
            "makeAutoObservable",
            "observable.array",
            "observable.box",
            "observable.map",
            "observable.set",
        ]) {
            match self.callee_api(call) {
                Some("observable") => self.visit_observable_call(call),
                Some(api) => self.visit_make_observable_call(call, api),
                None => {
                    if let Some(kind) = self.observable_value_call(call) {
                        self.create_value_observable(call, kind, 1);
                    }
                }
            }
        }
        self.register_decorated_classes();

        // Derivations and remaining actions, so accesses can be attributed to them.
        for call in self.sorted(&["reaction", "autorun", "when"]) {
            self.visit_reaction_call(call);
        }
        for call in self.sorted(&["computed"]) {
            self.visit_computed_call(call);
        }
        for call in self.sorted(&["runInAction"]) {
            self.visit_run_in_action_call(call);
        }

        // Instances of observable classes.
        for class in self.class_order.clone() {
            let (index, symbol) = self.classes[&class];
            if let Some(symbol) = symbol {
                self.visit_class_references(symbol, index);
            }
        }

        // Every reference to an observable.
        for (symbol, id) in self.observable_symbols.clone() {
            for node in self.value_refs(symbol) {
                self.classify_reference(node, &id, "binding");
            }
        }
        self.visit_this_references();
        for (symbol, id) in self.computed_symbols.clone() {
            for node in self.value_refs(symbol) {
                self.classify_computed_reference(node, &id);
            }
        }

        let mut accesses = self.finalize();
        self.renumber(&mut accesses);
        self.diagnostics
            .sort_by(|a, b| (a.span.start, a.span.end, a.code).cmp(&(b.span.start, b.span.end, b.code)));

        ir::Module {
            kind: "Module",
            ir_version: ir::IR_VERSION,
            filename: self.filename,
            module_specifier: self.module_specifier,
            imports: self.imports,
            observables: self.observables,
            computeds: self.computeds,
            accesses,
            reactions: self.reactions,
            actions: self.actions,
            unsupported: self.unsupported,
            diagnostics: self.diagnostics,
        }
    }

    /// One pass over all nodes: what each function directly contains.
    fn index_functions(&mut self) {
        let mut info: HashMap<NodeId, FnInfo> = HashMap::new();
        for node in self.nodes.iter() {
            let id = node.id();
            let kind = node.kind();
            let relevant = matches!(
                kind,
                AstKind::AwaitExpression(_)
                    | AstKind::ForOfStatement(_)
                    | AstKind::CallExpression(_)
                    | AstKind::IdentifierReference(_)
            );
            if !relevant {
                continue;
            }
            let Some(fn_id) = self.enclosing_function(id) else { continue };
            let entry = info.entry(fn_id).or_default();
            match kind {
                AstKind::AwaitExpression(a) => entry.awaits.push(a.span),
                AstKind::ForOfStatement(f) if f.r#await => entry.for_await_right_ends.push(f.right.span().end),
                AstKind::CallExpression(_) => entry.calls.push(id),
                AstKind::IdentifierReference(_) => entry.identifiers.push(id),
                _ => {}
            }
        }
        self.fn_info = info;
    }

    // -- imports --------------------------------------------------------------

    fn collect_imports(&mut self) {
        let mut refs: Vec<(NodeId, Option<&'static str>, String)> = vec![];
        for stmt in &self.program.body {
            let Statement::ImportDeclaration(decl) = stmt else { continue };
            if decl.source.value.as_str() != Some(self.module_specifier.as_str()) || decl.import_kind.is_type() {
                continue;
            }
            let Some(specifiers) = &decl.specifiers else { continue };
            for spec in specifiers {
                match spec {
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                        let local = s.local.name.as_str().to_string();
                        let span = self.span_of(s.span);
                        let message = format!(
                            "Namespace import \"{local}\" from \"{}\" is not analyzed; use named imports.",
                            self.module_specifier
                        );
                        self.diagnose("namespace-import", "error", message, span, vec![]);
                        self.imports.push(ir::Import::NamespaceImport { local, span });
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                        let local = s.local.name.as_str().to_string();
                        let span = self.span_of(s.span);
                        let message = format!(
                            "Default import \"{local}\" from \"{}\" is not analyzed; use named imports.",
                            self.module_specifier
                        );
                        self.diagnose("default-import", "error", message, span, vec![]);
                        self.imports.push(ir::Import::DefaultImport { local, span });
                    }
                    ImportDeclarationSpecifier::ImportSpecifier(s) => {
                        if s.import_kind.is_type() {
                            continue;
                        }
                        let local = s.local.name.as_str().to_string();
                        let span = self.span_of(s.span);
                        let imported = match &s.imported {
                            ModuleExportName::IdentifierName(n) => n.name.as_str().to_string(),
                            ModuleExportName::IdentifierReference(r) => r.name.as_str().to_string(),
                            ModuleExportName::StringLiteral(l) => l.value.display().to_string(),
                        };
                        let api = known_api(&imported);
                        // Types needn't be imported with `import type`.
                        if api.is_none() && self.only_types(s.local.symbol_id()) {
                            continue;
                        }
                        if api.is_none() {
                            let message =
                                format!("\"{imported}\" is not a known export of \"{}\".", self.module_specifier);
                            self.diagnose("unknown-import", "warning", message, span, vec![]);
                        }
                        self.imports.push(ir::Import::NamedImport { imported, local: local.clone(), api, span });
                        for node in self.value_refs(s.local.symbol_id()) {
                            if let Some(api) = api {
                                self.api_refs.insert(node, api);
                            }
                            refs.push((node, api, local.clone()));
                        }
                    }
                }
            }
        }
        refs.sort_by_key(|(node, _, _)| self.node_span(*node).start);
        for (node, api, local) in refs {
            self.classify_api_reference(node, api, &local);
        }
    }

    /// Whether an import is used, and only as a type.
    fn only_types(&self, symbol: SymbolId) -> bool {
        let mut references = self.scoping.get_resolved_references(symbol).peekable();
        references.peek().is_some() && references.all(|r| r.is_type())
    }

    fn classify_api_reference(&mut self, node: NodeId, api: Option<&'static str>, local: &str) {
        let mut expr = node;
        let mut member_name: Option<String> = None;
        if let Some(p) = self.parent(node)
            && let AstKind::StaticMemberExpression(m) = self.kind(p)
            && m.object.span() == self.node_span(node)
        {
            member_name = Some(m.property.name.as_str().to_string());
            expr = p;
        }
        let call = self.parent(expr).filter(|p| {
            matches!(self.kind(*p), AstKind::CallExpression(c) if c.callee.span() == self.node_span(expr))
        });
        let span = self.span(node);
        if api.is_some_and(|a| VALUES.contains(&a)) {
            return;
        }

        let Some(api) = api.filter(|a| !UNMODELED.contains(a)) else {
            self.unsupported.push(ir::UnsupportedUsage { kind: "UnsupportedUsage", api, local: local.into(), span });
            if let Some(api) = api {
                self.diagnose("unsupported-api", "error", format!("\"{api}\" is not supported by sobx yet."), span, vec![]);
            }
            return;
        };
        let position = call.unwrap_or(expr);
        if self.is_annotation_position(position) {
            if self.parent(position).is_some_and(|p| matches!(self.kind(p), AstKind::Decorator(_))) {
                self.decorator_refs.push(node);
            }
            return;
        }
        if let Some(member) = member_name.as_deref()
            && api == "observable"
            && let Some(kind) = OBSERVABLE_VALUES.iter().find(|k| **k == member)
        {
            match call {
                Some(call) => self.calls.entry(observable_value_key(kind)).or_default().push(call),
                None => {
                    let s = self.span(expr);
                    self.diagnose(
                        "api-not-called",
                        "error",
                        format!("\"{local}.{member}\" must be called directly; other uses cannot be analyzed."),
                        s,
                        vec![],
                    );
                }
            }
            return;
        }
        if let Some(member) = member_name {
            if API_MEMBERS.iter().any(|(a, members)| *a == api && members.contains(&member.as_str())) {
                return;
            }
            let s = self.span(expr);
            self.diagnose(
                "unsupported-api",
                "error",
                format!("\"{local}.{member}\" is not supported by sobx yet."),
                s,
                vec![],
            );
            return;
        }
        let Some(call) = call else {
            self.diagnose(
                "api-not-called",
                "error",
                format!("\"{local}\" must be called directly or used as an annotation; other uses cannot be analyzed."),
                span,
                vec![],
            );
            return;
        };
        self.calls.entry(api).or_default().push(call);
    }

    fn is_annotation_position(&self, node: NodeId) -> bool {
        let Some(parent) = self.parent(node) else { return false };
        match self.kind(parent) {
            AstKind::Decorator(_) => true,
            AstKind::ObjectProperty(p) if p.value.span() == self.node_span(node) => {
                let Some(object) = self.parent(parent) else { return false };
                let Some(call) = self.parent(object) else { return false };
                let AstKind::CallExpression(c) = self.kind(call) else { return false };
                if c.arguments.get(1).map(GetSpan::span) != Some(self.node_span(object)) {
                    return false;
                }
                self.expr_api(&c.callee).is_some_and(|api| ANNOTATING.contains(&api))
            }
            _ => false,
        }
    }

    fn sorted(&self, apis: &[&str]) -> Vec<NodeId> {
        let mut out: Vec<NodeId> = apis.iter().flat_map(|api| self.calls.get(api).cloned().unwrap_or_default()).collect();
        out.sort_by_key(|id| self.node_span(*id).start);
        out
    }

    fn callee_api(&self, call: NodeId) -> Option<&'static str> {
        let AstKind::CallExpression(c) = self.kind(call) else { return None };
        self.expr_api(&c.callee)
    }

    /// The API an expression refers to, if it is an identifier bound to an API import.
    fn expr_api(&self, expr: &Expression) -> Option<&'static str> {
        let Expression::Identifier(ident) = expr else { return None };
        self.api_refs.get(&ident.node_id()).copied()
    }

    // -- observable() / makeObservable() ----------------------------------------

    fn visit_observable_call(&mut self, call_id: NodeId) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let first = call.arguments.first();
        if first.is_none_or(|a| matches!(a, Argument::SpreadElement(_))) {
            let s = self.span(call_id);
            self.diagnose(
                "invalid-arguments",
                "error",
                "observable() expects an initial value as its first argument.".into(),
                s,
                vec![],
            );
        }
        let kind = match first {
            Some(Argument::ArrayExpression(_)) => Some("array"),
            Some(arg) => collection_kind(arg),
            None => None,
        };
        if let Some(kind) = kind {
            self.create_value_observable(call_id, kind, 2);
            return;
        }
        let object = match first {
            Some(Argument::ObjectExpression(o)) => Some(&**o),
            _ => None,
        };
        self.create_object_observable(call_id, call, "observable", object, call.arguments.get(1));
    }

    /// `observable.box/map/set(...)`: which kind, if `call` is one.
    fn observable_value_call(&self, call: NodeId) -> Option<&'static str> {
        let AstKind::CallExpression(c) = self.kind(call) else { return None };
        let Expression::StaticMemberExpression(m) = &c.callee else { return None };
        if self.expr_api(&m.object) != Some("observable") {
            return None;
        }
        OBSERVABLE_VALUES.iter().find(|k| **k == m.property.name.as_str()).copied()
    }

    /// An observable box, Map or Set. The runtime tracks its reads and writes; they are not
    /// analyzed (the value's own methods are not property accesses).
    fn create_value_observable(&mut self, call_id: NodeId, kind: &'static str, options_index: usize) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let id = self.next_observable_id();
        let span = self.span(call_id);
        let options = call.arguments.get(options_index).map(|a| self.options(a));
        let outer = self.outer(call_id);
        let resolved = self.resolve_result_binding(outer);
        // Arrays: record their accesses, so the compiler can rewrite index / `length` writes
        // (there is no Proxy to observe them). Maps, Sets and boxes are used through methods.
        if kind == "array"
            && let Some((symbol, b)) = &resolved
        {
            self.register_observable(*symbol, b, outer, &id);
        }
        let binding = resolved.map(|(_, b)| b);
        let what = match kind {
            "array" => "Observable array",
            "box" => "Observable box",
            "map" => "Observable Map",
            _ => "Observable Set",
        };
        self.diagnose(
            "opaque-observable",
            "info",
            format!("{what}: its reads and writes are tracked by the runtime but not analyzed."),
            span,
            vec![id.clone()],
        );
        self.observables.push(ir::Observable {
            kind: "Observable",
            id,
            source: "observable",
            target: Target::Object { binding },
            shape: match kind {
                "array" => Shape::Array,
                "box" => Shape::Box,
                "map" => Shape::Map,
                _ => Shape::Set,
            },
            options,
            span,
        });
    }

    fn visit_make_observable_call(&mut self, call_id: NodeId, api: &'static str) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let span = self.span(call_id);
        let target = call.arguments.first();
        let annotations = call.arguments.get(1);

        if let Some(Argument::ObjectExpression(o)) = target {
            self.create_object_observable(call_id, call, api, Some(o), annotations);
            return;
        }
        let Some(Argument::ThisExpression(this)) = target else {
            let s = target.map_or(span, |t| self.span_of(t.span()));
            self.diagnose(
                "unsupported-target",
                "error",
                format!("{api}() target must be `this` (in a class constructor) or an object literal."),
                s,
                vec![],
            );
            return;
        };
        self.make_targets.insert(this.node_id());
        let Some(class) = self.enclosing_constructor_class(call_id) else {
            self.diagnose(
                "make-observable-outside-constructor",
                "error",
                format!("{api}(this) must be called directly in a class constructor."),
                span,
                vec![],
            );
            return;
        };
        if self.classes.contains_key(&class) {
            self.diagnose(
                "unsupported-target",
                "error",
                format!("Class is already made observable; multiple {api}() calls are not supported."),
                span,
                vec![],
            );
            return;
        }
        let options = call.arguments.get(2).map(|a| self.options(a));
        self.create_class_observable(class, api, annotations, options, span);
    }

    fn create_object_observable(
        &mut self,
        call_id: NodeId,
        call: &'a CallExpression<'a>,
        source: &'static str,
        object: Option<&'a ObjectExpression<'a>>,
        annotations: Option<&'a Argument<'a>>,
    ) {
        let id = self.next_observable_id();
        let span = self.span(call_id);
        let options = call.arguments.get(2).map(|a| self.options(a));
        let shape = match object {
            Some(o) => {
                let raw = self.object_members(o);
                self.build_shape(&id, source, raw, annotations, options.as_ref(), span, false)
            }
            None => Shape::Unknown,
        };
        let outer = self.outer(call_id);
        let resolved = self.resolve_result_binding(outer);
        if let Some((symbol, binding)) = &resolved {
            self.register_observable(*symbol, binding, outer, &id);
            if self.is_declared_exported(*symbol) {
                let ident = self.span_of(self.scoping.symbol_span(*symbol));
                self.diagnose(
                    "observable-escape",
                    "error",
                    format!("Observable \"{}\" is exported; accesses in other modules are not tracked.", binding.name),
                    ident,
                    vec![id.clone()],
                );
            }
        } else {
            self.diagnose(
                "unbound-observable",
                "error",
                format!("{source}() result must be stored in a variable to be analyzed."),
                span,
                vec![id.clone()],
            );
        }
        if let Some(o) = object {
            self.this_owners.insert(o.node_id(), id.clone());
        }
        self.observables.push(ir::Observable {
            kind: "Observable",
            id,
            source,
            target: Target::Object { binding: resolved.map(|(_, b)| b) },
            shape,
            options,
            span,
        });
    }

    fn create_class_observable(
        &mut self,
        class_id: NodeId,
        source: &'static str,
        annotations: Option<&'a Argument<'a>>,
        options: Option<Options>,
        span: ir::Span,
    ) {
        let AstKind::Class(class) = self.kind(class_id) else { return };
        let id = self.next_observable_id();
        let name = self.class_name(class_id, class);
        let symbol = self.class_symbol(class_id, class);
        let exported = symbol.is_some_and(|s| self.is_exported(s))
            || self.parent(class_id).is_some_and(|p| self.is_export_kind(p));

        let raw = self.class_members(class);
        let shape = {
            let inherits = class.heritage.is_some();
            self.build_shape(&id, source, raw, annotations, options.as_ref(), span, inherits)
        };
        let class_span = self.span(class_id);
        self.classes.insert(class_id, (self.observables.len(), symbol));
        self.class_order.push(class_id);
        self.this_owners.insert(class_id, id.clone());
        self.observables.push(ir::Observable {
            kind: "Observable",
            id: id.clone(),
            source,
            target: Target::Class { class_name: name.clone(), exported, instances: vec![], class_span },
            shape,
            options,
            span,
        });
        if exported {
            let s = class.id.as_ref().map_or(class_span, |i| self.span_of(i.span));
            self.diagnose(
                "observable-escape",
                "error",
                format!(
                    "Observable class \"{}\" is exported; instances created in other modules are not tracked.",
                    name.as_deref().unwrap_or("<anonymous>")
                ),
                s,
                vec![id],
            );
        }
    }

    /// Classes that use API decorators but never call `makeObservable(this)` rely on standard
    /// (2022.3) decorators, which need no call. Model them from their decorators.
    fn register_decorated_classes(&mut self) {
        let mut refs = self.decorator_refs.clone();
        refs.sort_by_key(|id| self.node_span(*id).start);
        for node in refs {
            let Some(class) = self.nodes.ancestor_ids(node).find(|a| matches!(self.kind(*a), AstKind::Class(_)))
            else {
                continue;
            };
            if self.classes.contains_key(&class) {
                continue;
            }
            let span = self.span(class);
            self.create_class_observable(class, "decorators", None, None, span);
        }
    }

    fn next_observable_id(&self) -> String {
        format!("observable:{}", self.observables.len())
    }

    fn register_observable(&mut self, symbol: SymbolId, binding: &Binding, outer: NodeId, id: &str) {
        let assignment = self.parent(outer).filter(|p| matches!(self.kind(*p), AstKind::AssignmentExpression(_)));
        if self.symbol_observable.contains_key(&symbol) {
            if let Some(a) = assignment {
                if self.reported.contains(&a) {
                    return;
                }
                self.reported.insert(a);
            }
            let s = self.span(assignment.unwrap_or(outer));
            self.diagnose(
                "observable-reassigned",
                "error",
                format!("\"{}\" is assigned more than one observable.", binding.name),
                s,
                vec![id.into()],
            );
            return;
        }
        self.symbol_observable.insert(symbol, id.into());
        self.observable_symbols.push((symbol, id.into()));
        self.check_reassignments(symbol, assignment, id);
    }

    fn check_reassignments(&mut self, symbol: SymbolId, creation: Option<NodeId>, id: &str) {
        let name = self.scoping.symbol_name(symbol).to_string();
        for &rid in self.scoping.get_resolved_reference_ids(symbol) {
            let reference = self.scoping.get_reference(rid);
            if !reference.is_write() {
                continue;
            }
            let ident = reference.node_id();
            let violation = self.parent(ident).unwrap_or(ident);
            if Some(violation) == creation || self.reported.contains(&violation) {
                continue;
            }
            self.reported.insert(violation);
            let s = self.span(violation);
            self.diagnose(
                "observable-reassigned",
                "error",
                format!("\"{name}\" is reassigned; references may not point at the observable."),
                s,
                vec![id.into()],
            );
        }
    }

    // -- members & annotations ----------------------------------------------------

    fn object_members(&self, object: &'a ObjectExpression<'a>) -> (Vec<RawMember<'a>>, bool) {
        let mut members = vec![];
        let mut open = false;
        for prop in &object.properties {
            let ObjectPropertyKind::ObjectProperty(p) = prop else {
                open = true;
                continue;
            };
            let AccessKey::Static { name } = property_key(&p.key, p.computed) else {
                open = true;
                continue;
            };
            if p.kind == PropertyKind::Set {
                continue;
            }
            let span = self.span_of(p.span);
            let function = match &p.value {
                Expression::FunctionExpression(f) if p.method || p.kind == PropertyKind::Get => Some(&**f),
                _ => None,
            };
            if let Some(f) = function {
                let getter = p.kind == PropertyKind::Get;
                members.push(RawMember {
                    key: name,
                    member_kind: if getter { "getter" } else { "method" },
                    value_kind: if getter {
                        "getter"
                    } else if f.generator {
                        "generator"
                    } else {
                        "function"
                    },
                    is_static: false,
                    accessor: false,
                    value: Some(Value_::Method(f)),
                    decorators: vec![],
                    span,
                });
                continue;
            }
            members.push(RawMember {
                key: name,
                member_kind: "field",
                value_kind: self.value_kind_of(&p.value),
                is_static: false,
                accessor: false,
                value: Some(Value_::Expr(&p.value)),
                decorators: vec![],
                span,
            });
        }
        (members, open)
    }

    fn class_members(&self, class: &'a Class<'a>) -> (Vec<RawMember<'a>>, bool) {
        let mut members: Vec<RawMember<'a>> = vec![];
        let mut open = false;
        let mut ctor: Option<&'a Function<'a>> = None;

        for element in &class.body.body {
            match element {
                ClassElement::MethodDefinition(m) => {
                    if m.kind == MethodDefinitionKind::Constructor {
                        ctor = Some(&m.value);
                        continue;
                    }
                    if matches!(m.key, PropertyKey::PrivateIdentifier(_)) {
                        continue;
                    }
                    let AccessKey::Static { name } = property_key(&m.key, m.computed) else {
                        open = true;
                        continue;
                    };
                    if m.kind == MethodDefinitionKind::Set {
                        continue;
                    }
                    let getter = m.kind == MethodDefinitionKind::Get;
                    members.push(RawMember {
                        key: name,
                        member_kind: if getter { "getter" } else { "method" },
                        value_kind: if getter {
                            "getter"
                        } else if m.value.generator {
                            "generator"
                        } else {
                            "function"
                        },
                        is_static: m.r#static,
                        accessor: false,
                        value: Some(Value_::Method(&m.value)),
                        decorators: m.decorators.iter().collect(),
                        span: self.span_of(m.span),
                    });
                }
                ClassElement::PropertyDefinition(p) => {
                    if matches!(p.key, PropertyKey::PrivateIdentifier(_)) {
                        continue;
                    }
                    let AccessKey::Static { name } = property_key(&p.key, p.computed) else {
                        open = true;
                        continue;
                    };
                    members.push(RawMember {
                        key: name,
                        member_kind: "field",
                        value_kind: p.value.as_ref().map_or("unknown", |v| self.value_kind_of(v)),
                        is_static: p.r#static,
                        accessor: false,
                        value: p.value.as_ref().map(Value_::Expr),
                        decorators: p.decorators.iter().collect(),
                        span: self.span_of(p.span),
                    });
                }
                ClassElement::AccessorProperty(p) => {
                    if matches!(p.key, PropertyKey::PrivateIdentifier(_)) {
                        continue;
                    }
                    let AccessKey::Static { name } = property_key(&p.key, p.computed) else {
                        open = true;
                        continue;
                    };
                    members.push(RawMember {
                        key: name,
                        member_kind: "field",
                        value_kind: p.value.as_ref().map_or("unknown", |v| self.value_kind_of(v)),
                        is_static: p.r#static,
                        accessor: true,
                        value: p.value.as_ref().map(Value_::Expr),
                        decorators: p.decorators.iter().collect(),
                        span: self.span_of(p.span),
                    });
                }
                _ => {}
            }
        }

        // Fields assigned in the constructor: `this.x = ...`.
        let statements = ctor.and_then(|f| f.body.as_ref()).map(|b| &b.statements);
        for stmt in statements.into_iter().flatten() {
            let Statement::ExpressionStatement(s) = stmt else { continue };
            let Expression::AssignmentExpression(a) = &s.expression else { continue };
            if a.operator != AssignmentOperator::Assign {
                continue;
            }
            let key = match &a.left {
                AssignmentTarget::StaticMemberExpression(m) if matches!(m.object, Expression::ThisExpression(_)) => {
                    AccessKey::Static { name: m.property.name.as_str().to_string() }
                }
                AssignmentTarget::ComputedMemberExpression(m) if matches!(m.object, Expression::ThisExpression(_)) => {
                    computed_key(&m.expression)
                }
                AssignmentTarget::PrivateFieldExpression(m) if matches!(m.object, Expression::ThisExpression(_)) => {
                    AccessKey::Dynamic
                }
                _ => continue,
            };
            let AccessKey::Static { name } = key else {
                open = true;
                continue;
            };
            if members.iter().any(|m| m.key == name && !m.is_static) {
                continue;
            }
            members.push(RawMember {
                key: name,
                member_kind: "field",
                value_kind: self.value_kind_of(&a.right),
                is_static: false,
                accessor: false,
                value: Some(Value_::Expr(&a.right)),
                decorators: vec![],
                span: self.span_of(a.span),
            });
        }
        (members, open)
    }

    #[allow(clippy::too_many_arguments)]
    fn build_shape(
        &mut self,
        observable: &str,
        source: &'static str,
        (raw, open): (Vec<RawMember<'a>>, bool),
        annotations: Option<&'a Argument<'a>>,
        options: Option<&Options>,
        call_span: ir::Span,
        inherits: bool,
    ) -> Shape {
        let explicit = annotations.map(|a| self.explicit_annotations(a, source, observable));
        let use_decorators = source == "decorators" || (source == "makeObservable" && annotations.is_none());
        let defaults = self.inference_defaults(options, observable, call_span);

        let members: Vec<Member> = raw
            .iter()
            .map(|m| self.resolve_member(observable, source, m, explicit.as_ref(), use_decorators, defaults))
            .collect();

        if let Some(explicit) = &explicit
            && !open
            && !inherits
        {
            let mut seen = HashSet::new();
            for (key, _, span) in &explicit.entries {
                if !seen.insert(key.clone()) {
                    continue;
                }
                if !raw.iter().any(|m| &m.key == key && !m.is_static) {
                    let span = explicit.entries.iter().rev().find(|(k, _, _)| k == key).map_or(*span, |e| e.2);
                    self.diagnose(
                        "unknown-annotation-key",
                        "warning",
                        format!("Annotation for \"{key}\" does not match any member."),
                        span,
                        vec![observable.into()],
                    );
                }
            }
        }
        if source == "makeObservable" && explicit.is_none() && !inherits && !members.iter().any(|m| m.annotation.is_some()) {
            self.diagnose(
                "missing-annotations",
                "warning",
                "makeObservable() without an annotations object or decorators makes nothing observable.".into(),
                call_span,
                vec![observable.into()],
            );
        }
        Shape::Object { members, open }
    }

    fn inference_defaults(&mut self, options: Option<&Options>, observable: &str, call_span: ir::Span) -> Defaults {
        let mut defaults = Defaults { auto_bind: false, deep: true };
        let Some(options) = options else { return defaults };
        let mut unresolved = false;
        let span = match options {
            Options::Unknown { span } => {
                unresolved = true;
                *span
            }
            Options::Object { entries, open } => {
                unresolved |= *open;
                for (key, slot) in [("autoBind", &mut defaults.auto_bind), ("deep", &mut defaults.deep)] {
                    let Some(entry) = entries.get(key) else { continue };
                    match entry.get("value") {
                        Some(Value::Bool(b)) if entry.get("kind") == Some(&json!("literal")) => *slot = *b,
                        _ => unresolved = true,
                    }
                }
                call_span
            }
        };
        if unresolved {
            self.diagnose(
                "unresolved-arguments",
                "warning",
                "Options could not be resolved statically; inferred annotations assume `autoBind: false` and `deep: true`.".into(),
                span,
                vec![observable.into()],
            );
        }
        defaults
    }

    fn explicit_annotations(&mut self, arg: &'a Argument<'a>, source: &'static str, observable: &str) -> Explicit {
        let Argument::ObjectExpression(object) = arg else {
            let s = self.span_of(arg.span());
            self.diagnose(
                "unresolved-arguments",
                "error",
                format!("{source}() annotations must be an object literal to be analyzed."),
                s,
                vec![observable.into()],
            );
            return Explicit { entries: vec![] };
        };
        let mut entries = vec![];
        let mut open = false;
        for prop in &object.properties {
            let ObjectPropertyKind::ObjectProperty(p) = prop else {
                open = true;
                continue;
            };
            let AccessKey::Static { name } = property_key(&p.key, p.computed) else {
                open = true;
                continue;
            };
            let written = if p.method || p.kind != PropertyKind::Init {
                Written::Annotation(Annotation::Unknown)
            } else {
                self.parse_annotation(&p.value)
            };
            entries.push((name, written, self.span_of(p.span)));
        }
        if open {
            let s = self.span_of(object.span);
            self.diagnose(
                "unresolved-arguments",
                "warning",
                "Annotations object has spreads or computed keys; annotations may be incomplete.".into(),
                s,
                vec![observable.into()],
            );
        }
        Explicit { entries }
    }

    fn parse_annotation(&self, expr: &Expression) -> Written {
        if let Expression::BooleanLiteral(b) = expr {
            return if b.value { Written::Infer } else { Written::Annotation(Annotation::Excluded) };
        }
        let callee = match expr {
            Expression::CallExpression(c) => &c.callee,
            other => other,
        };
        if let Some(api) = self.expr_api(callee) {
            return Written::Annotation(match api {
                "observable" => Annotation::Observable { modifier: "deep" },
                "computed" => Annotation::Computed { modifier: "default" },
                "action" => Annotation::Action { bound: false },
                "flow" => Annotation::Flow { bound: false },
                "_autoAction" => Annotation::AutoAction { bound: false },
                _ => Annotation::Unknown,
            });
        }
        if let Expression::StaticMemberExpression(m) = callee {
            let modifier = m.property.name.as_str();
            let annotation = match (self.expr_api(&m.object), modifier) {
                (Some("observable"), "deep") => Some(Annotation::Observable { modifier: "deep" }),
                (Some("observable"), "ref") => Some(Annotation::Observable { modifier: "ref" }),
                (Some("observable"), "shallow") => Some(Annotation::Observable { modifier: "shallow" }),
                (Some("observable"), "struct") => Some(Annotation::Observable { modifier: "struct" }),
                (Some("computed"), "struct") => Some(Annotation::Computed { modifier: "struct" }),
                (Some("action"), "bound") => Some(Annotation::Action { bound: true }),
                (Some("flow"), "bound") => Some(Annotation::Flow { bound: true }),
                _ => None,
            };
            if let Some(a) = annotation {
                return Written::Annotation(a);
            }
        }
        Written::Annotation(Annotation::Unknown)
    }

    fn resolve_member(
        &mut self,
        observable: &str,
        source: &'static str,
        m: &RawMember<'a>,
        explicit: Option<&Explicit>,
        use_decorators: bool,
        defaults: Defaults,
    ) -> Member {
        let mut annotation = None;
        let mut annotation_source = None;
        if !m.is_static {
            let written = explicit.and_then(|e| e.get(&m.key)).cloned();
            let decorated = if use_decorators { self.decorator_annotation(m) } else { None };
            if let Some(w) = written {
                match w {
                    Written::Infer => {
                        annotation = Some(infer_annotation(m, defaults));
                        annotation_source = Some("inferred");
                    }
                    Written::Annotation(a) => {
                        annotation = Some(a);
                        annotation_source = Some("explicit");
                    }
                }
            } else if let Some(d) = decorated {
                annotation = Some(match d {
                    Written::Infer => infer_annotation(m, defaults),
                    Written::Annotation(a) => a,
                });
                annotation_source = Some("decorator");
            } else if source == "observable" || source == "makeAutoObservable" {
                annotation = Some(infer_annotation(m, defaults));
                annotation_source = Some("inferred");
            }
        }

        let mut member = Member {
            key: m.key.clone(),
            member_kind: m.member_kind,
            value_kind: m.value_kind,
            is_static: m.is_static,
            accessor: m.accessor,
            annotation: annotation.clone(),
            annotation_source,
            computed: None,
            action: None,
            span: m.span,
        };
        if let Some(a) = &annotation {
            self.apply_annotation(observable, source, m, &mut member, a);
        }
        if !m.is_static && m.member_kind != "getter" {
            let fn_node = match m.value {
                Some(Value_::Method(f)) => Some(f.node_id()),
                Some(Value_::Expr(Expression::ArrowFunctionExpression(f))) => Some(f.node_id()),
                Some(Value_::Expr(Expression::FunctionExpression(f))) => Some(f.node_id()),
                _ => None,
            };
            if let Some(node) = fn_node {
                // `action` runs untracked; `autoAction` and plain functions run tracked.
                let untracked = matches!(annotation, Some(Annotation::Action { .. } | Annotation::Flow { .. }));
                self.member_fns.insert(format!("{observable}|{}", m.key), (node, untracked));
            }
        }
        member
    }

    fn decorator_annotation(&self, m: &RawMember<'a>) -> Option<Written> {
        m.decorators.iter().map(|d| self.parse_annotation(&d.expression)).find(|w| {
            !matches!(w, Written::Annotation(Annotation::Unknown))
        })
    }

    /// Validate an annotation against its member and create the backing computed / action.
    fn apply_annotation(
        &mut self,
        observable: &str,
        source: &'static str,
        m: &RawMember<'a>,
        member: &mut Member,
        annotation: &Annotation,
    ) {
        let invalid = |this: &mut Self, message: String| {
            this.diagnose("invalid-annotation", "error", message, m.span, vec![observable.into()]);
        };
        match annotation {
            Annotation::Observable { .. } => {
                if m.member_kind == "getter" {
                    invalid(self, format!("\"{}\" is a {}; it cannot be observable.", m.key, m.member_kind));
                } else if source == "decorators" && !m.accessor {
                    invalid(
                        self,
                        format!(
                            "\"{}\" needs `accessor` to be observable with standard decorators (or call makeObservable(this) when using legacy decorators).",
                            m.key
                        ),
                    );
                }
            }
            Annotation::Computed { .. } => {
                let (true, Some(Value_::Method(f))) = (m.member_kind == "getter", m.value) else {
                    invalid(self, format!("\"{}\" must be a getter to be computed.", m.key));
                    return;
                };
                let id = format!("computed:{}", self.computeds.len());
                let body = self.method_ref(f, m.span, Role::Tracked(id.clone()));
                self.computeds.push(ir::Computed {
                    kind: "Computed",
                    id: id.clone(),
                    source: ComputedSource::Getter { observable: observable.into(), key: m.key.clone() },
                    body,
                    options: None,
                    dependencies: vec![],
                    indirect_dependencies: vec![],
                    span: m.span,
                });
                member.computed = Some(id);
            }
            Annotation::Action { bound } | Annotation::AutoAction { bound } | Annotation::Flow { bound } => {
                if let Some(Value_::Expr(Expression::CallExpression(c))) = m.value
                    && let Some(existing) = self.action_calls.get(&c.node_id())
                {
                    member.action = Some(existing.clone());
                    return;
                }
                let is_flow = matches!(annotation, Annotation::Flow { .. });
                if m.member_kind == "getter"
                    || (m.member_kind == "field" && !matches!(m.value_kind, "function" | "generator" | "unknown"))
                {
                    invalid(self, format!("\"{}\" is not a function; it cannot be an action.", m.key));
                    return;
                }
                if is_flow && !matches!(m.value_kind, "generator" | "unknown") {
                    invalid(self, format!("\"{}\" must be a generator function to be a flow.", m.key));
                    return;
                }
                let id = format!("action:{}", self.actions.len());
                let body = match m.value {
                    Some(Value_::Method(f)) => self.method_ref(f, m.span, Role::Action(id.clone())),
                    Some(Value_::Expr(e)) => self.function_ref(e, Role::Action(id.clone())),
                    None => FunctionRef::Opaque { span: m.span },
                };
                if let FunctionRef::Opaque { span } = body {
                    self.diagnose(
                        "opaque-function",
                        "warning",
                        format!("Action \"{}\" is not an inline function; its writes cannot be attributed to it.", m.key),
                        span,
                        vec![id.clone()],
                    );
                }
                let kind = match annotation {
                    Annotation::Action { .. } => "action",
                    Annotation::Flow { .. } => "flow",
                    _ => "autoAction",
                };
                self.actions.push(ir::Action {
                    kind: "Action",
                    id: id.clone(),
                    source: ActionSource::Member {
                        observable: observable.into(),
                        key: m.key.clone(),
                        annotation: kind,
                        bound: *bound,
                    },
                    body,
                    writes: vec![],
                    span: m.span,
                });
                member.action = Some(id);
            }
            // `override`, or a value from elsewhere.
            Annotation::Unknown => self.diagnose(
                "unresolved-arguments",
                "warning",
                format!("Could not resolve the annotation for \"{}\".", m.key),
                m.span,
                vec![observable.into()],
            ),
            Annotation::Excluded => {}
        }
    }

    fn value_kind_of(&self, expr: &Expression) -> &'static str {
        if let Expression::CallExpression(c) = expr
            && self.expr_api(&c.callee) == Some("action")
        {
            return "function";
        }
        value_kind(expr)
    }

    // -- reaction() / autorun() / computed() ---------------------------------------

    fn visit_reaction_call(&mut self, call_id: NodeId) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let api = self.expr_api(&call.callee).unwrap_or("reaction");
        let span = self.span(call_id);
        let id = format!("reaction:{}", self.reactions.len());
        let disposer_used =
            !self.parent(self.outer(call_id)).is_some_and(|p| matches!(self.kind(p), AstKind::ExpressionStatement(_)));
        let expr = |i: usize| call.arguments.get(i).and_then(|a| a.as_expression());

        if api == "autorun" {
            let Some(body) = expr(0) else {
                self.diagnose("invalid-arguments", "error", "autorun() expects a function.".into(), span, vec![]);
                return;
            };
            let body = self.function_ref(body, Role::Tracked(id.clone()));
            if let FunctionRef::Opaque { span } = body {
                self.opaque("autorun() body", span, &id);
            }
            let options = call.arguments.get(1).map(|a| self.options(a));
            self.reactions.push(ir::Reaction {
                kind: "Reaction",
                id,
                api: "autorun",
                data: None,
                effect: None,
                body: Some(body),
                predicate: None,
                options,
                dependencies: vec![],
                indirect_dependencies: vec![],
                disposer_used,
                span,
            });
            return;
        }

        if api == "when" {
            let Some(predicate) = expr(0) else {
                self.diagnose("invalid-arguments", "error", "when() expects a predicate function.".into(), span, vec![]);
                return;
            };
            let predicate = self.function_ref(predicate, Role::Tracked(id.clone()));
            if let FunctionRef::Opaque { span } = predicate {
                self.opaque("when() predicate", span, &id);
            }
            // when(predicate, effect, options?) or when(predicate, options?) (the promise form).
            let (effect, options_arg) = match call.arguments.get(1) {
                Some(Argument::ObjectExpression(_)) | None => (None, call.arguments.get(1)),
                Some(_) => (expr(1).map(|e| self.function_ref(e, Role::Effect(id.clone()))), call.arguments.get(2)),
            };
            let options = options_arg.map(|a| self.options(a));
            self.reactions.push(ir::Reaction {
                kind: "Reaction",
                id,
                api: "when",
                data: None,
                effect,
                body: None,
                predicate: Some(predicate),
                options,
                dependencies: vec![],
                indirect_dependencies: vec![],
                disposer_used,
                span,
            });
            return;
        }

        let (Some(data), Some(effect)) = (expr(0), expr(1)) else {
            self.diagnose(
                "invalid-arguments",
                "error",
                "reaction() expects a data function and an effect function.".into(),
                span,
                vec![],
            );
            return;
        };
        let data = self.function_ref(data, Role::Tracked(id.clone()));
        let effect = self.function_ref(effect, Role::Effect(id.clone()));
        if let FunctionRef::Opaque { span } = data {
            self.opaque("reaction() data function", span, &id);
        }
        let options = call.arguments.get(2).map(|a| self.options(a));
        self.reactions.push(ir::Reaction {
            kind: "Reaction",
            id,
            api: "reaction",
            data: Some(data),
            effect: Some(effect),
            body: None,
            predicate: None,
            options,
            dependencies: vec![],
            indirect_dependencies: vec![],
            disposer_used,
            span,
        });
    }

    fn visit_computed_call(&mut self, call_id: NodeId) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let span = self.span(call_id);
        // `computed({ ... })`: an annotation with options.
        if matches!(call.arguments.first(), Some(Argument::ObjectExpression(_))) {
            return;
        }
        let Some(body) = call.arguments.first().and_then(|a| a.as_expression()) else {
            self.diagnose("invalid-arguments", "error", "computed() expects a function.".into(), span, vec![]);
            return;
        };
        let id = format!("computed:{}", self.computeds.len());
        let body = self.function_ref(body, Role::Tracked(id.clone()));
        if let FunctionRef::Opaque { span } = body {
            self.opaque("computed() body", span, &id);
        }
        let outer = self.outer(call_id);
        let resolved = self.resolve_result_binding(outer);
        if let Some((symbol, _)) = &resolved {
            self.computed_symbols.push((*symbol, id.clone()));
            let creation = self.parent(outer).filter(|p| matches!(self.kind(*p), AstKind::AssignmentExpression(_)));
            self.check_reassignments(*symbol, creation, &id);
        } else {
            self.diagnose(
                "unbound-observable",
                "error",
                "computed() result must be stored in a variable to be analyzed.".into(),
                span,
                vec![id.clone()],
            );
        }
        let options = call.arguments.get(1).map(|a| self.options(a));
        self.computeds.push(ir::Computed {
            kind: "Computed",
            id,
            source: ComputedSource::Call { binding: resolved.map(|(_, b)| b) },
            body,
            options,
            dependencies: vec![],
            indirect_dependencies: vec![],
            span,
        });
    }

    fn opaque(&mut self, what: &str, span: ir::Span, id: &str) {
        self.diagnose(
            "opaque-function",
            "error",
            format!("{what} must be an inline function so its dependencies can be analyzed."),
            span,
            vec![id.into()],
        );
    }

    // -- runInAction() / action() -----------------------------------------------

    fn visit_run_in_action_call(&mut self, call_id: NodeId) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let Some(body) = call.arguments.first().and_then(|a| a.as_expression()) else {
            let s = self.span(call_id);
            self.diagnose("invalid-arguments", "error", "runInAction() expects a function.".into(), s, vec![]);
            return;
        };
        self.create_action(call_id, body, ActionSource::RunInAction, "runInAction");
    }

    fn visit_action_call(&mut self, call_id: NodeId) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let first = call.arguments.first();
        let name = match first {
            Some(Argument::StringLiteral(s)) => Some(s.value.display().to_string()),
            _ => None,
        };
        // `action("name")`: a named annotation.
        if name.is_some() && call.arguments.len() == 1 {
            return;
        }
        let body_arg = if name.is_some() { call.arguments.get(1) } else { first };
        let Some(body) = body_arg.and_then(|a| a.as_expression()) else {
            let s = self.span(call_id);
            self.diagnose(
                "invalid-arguments",
                "error",
                "action() expects a function (optionally preceded by a name).".into(),
                s,
                vec![],
            );
            return;
        };
        let binding = self.resolve_result_binding(self.outer(call_id)).map(|(_, b)| b);
        let id = self.create_action(call_id, body, ActionSource::Action { name, binding }, "action");
        self.action_calls.insert(call_id, id);
    }

    fn visit_flow_call(&mut self, call_id: NodeId) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let Some(body) = call.arguments.first().and_then(|a| a.as_expression()) else {
            let s = self.span(call_id);
            self.diagnose("invalid-arguments", "error", "flow() expects a generator function.".into(), s, vec![]);
            return;
        };
        let binding = self.resolve_result_binding(self.outer(call_id)).map(|(_, b)| b);
        let id = self.create_action(call_id, body, ActionSource::Flow { binding }, "flow");
        self.action_calls.insert(call_id, id);
    }

    fn create_action(&mut self, call_id: NodeId, body: &'a Expression<'a>, source: ActionSource, kind: &str) -> String {
        let id = format!("action:{}", self.actions.len());
        let body = self.function_ref(body, Role::Action(id.clone()));
        if let FunctionRef::Opaque { span } = body {
            self.diagnose(
                "opaque-function",
                "warning",
                format!("{kind}() body is not an inline function; its writes cannot be attributed to the action."),
                span,
                vec![id.clone()],
            );
        }
        let span = self.span(call_id);
        self.actions.push(ir::Action { kind: "Action", id: id.clone(), source, body, writes: vec![], span });
        id
    }

    fn set_role(&mut self, node: NodeId, role: Role) {
        if self.roles.insert(node, role).is_none() {
            self.role_order.push(node);
        }
    }

    fn function_ref(&mut self, expr: &'a Expression<'a>, role: Role) -> FunctionRef {
        match expr {
            Expression::ArrowFunctionExpression(f) => {
                self.set_role(f.node_id(), role);
                FunctionRef::Inline { params: param_count(&f.params), is_async: f.r#async, span: self.span_of(f.span) }
            }
            Expression::FunctionExpression(f) => {
                self.set_role(f.node_id(), role);
                FunctionRef::Inline { params: param_count(&f.params), is_async: f.r#async, span: self.span_of(f.span) }
            }
            other => FunctionRef::Opaque { span: self.span_of(other.span()) },
        }
    }

    /// A method / getter function; `span` is the member's span (as Babel's ClassMethod / ObjectMethod).
    fn method_ref(&mut self, f: &'a Function<'a>, span: ir::Span, role: Role) -> FunctionRef {
        self.set_role(f.node_id(), role);
        FunctionRef::Inline { params: param_count(&f.params), is_async: f.r#async, span }
    }

    fn options(&self, arg: &Argument<'a>) -> Options {
        let Argument::ObjectExpression(object) = arg else {
            return Options::Unknown { span: self.span_of(arg.span()) };
        };
        let mut entries = Map::new();
        let mut open = false;
        for prop in &object.properties {
            let ObjectPropertyKind::ObjectProperty(p) = prop else {
                open = true;
                continue;
            };
            let AccessKey::Static { name } = property_key(&p.key, p.computed) else {
                open = true;
                continue;
            };
            let value = if p.method || p.kind != PropertyKind::Init {
                json!({ "kind": "unknown" })
            } else {
                option_value(&p.value)
            };
            entries.insert(name, value);
        }
        Options::Object { entries, open }
    }

    // -- class & this references ----------------------------------------------------

    fn visit_class_references(&mut self, symbol: SymbolId, index: usize) {
        let name = self.scoping.symbol_name(symbol).to_string();
        let id = self.observables[index].id.clone();
        for node in self.value_refs(symbol) {
            let r = self.outer(node);
            let r_span = self.node_span(r);
            let Some(parent) = self.parent(r) else { continue };
            if let AstKind::NewExpression(n) = self.kind(parent)
                && n.callee.span() == r_span
            {
                let outer = self.outer(parent);
                let Some((instance, binding)) = self.resolve_result_binding(outer) else {
                    let s = self.span(parent);
                    self.diagnose(
                        "observable-escape",
                        "error",
                        format!(
                            "Instance of observable class \"{name}\" is not stored in a variable; accesses through it are not tracked."
                        ),
                        s,
                        vec![id.clone()],
                    );
                    continue;
                };
                if let Target::Class { instances, .. } = &mut self.observables[index].target {
                    instances.push(binding.clone());
                }
                self.register_observable(instance, &binding, outer, &id);
                continue;
            }
            let harmless = self.member_key_if_object(parent, r_span).is_some()
                || match self.kind(parent) {
                    AstKind::BinaryExpression(b) => b.operator == BinaryOperator::Instanceof || b.operator.is_equality(),
                    AstKind::ExpressionStatement(_) | AstKind::ExportSpecifier(_) => true,
                    _ => false,
                };
            if harmless {
                continue;
            }
            let s = self.span(r);
            let why = self.describe_escape(parent, r_span);
            self.diagnose(
                "observable-escape",
                "error",
                format!(
                    "Observable class \"{name}\" escapes analysis ({why}); instances created through other references are not tracked."
                ),
                s,
                vec![id.clone()],
            );
        }
    }

    fn visit_this_references(&mut self) {
        let mut refs: Vec<(NodeId, String)> = vec![];
        for node in self.nodes.iter() {
            if !matches!(node.kind(), AstKind::ThisExpression(_)) || self.make_targets.contains(&node.id()) {
                continue;
            }
            if let Some(owner) = self.this_owner(node.id())
                && let Some(id) = self.this_owners.get(&owner)
            {
                refs.push((node.id(), id.clone()));
            }
        }
        refs.sort_by_key(|(n, _)| self.node_span(*n).start);
        for (node, id) in refs {
            self.classify_reference(node, &id, "this");
        }
    }

    // -- observable references ----------------------------------------------------

    fn classify_reference(&mut self, node: NodeId, id: &str, receiver: &'static str) {
        let name = self.reference_name(node);
        let r = self.outer(node);
        let r_span = self.node_span(r);
        let Some(parent) = self.parent(r) else { return };
        let context = self.context_of(node);

        if let Some(key) = self.member_key_if_object(parent, r_span) {
            self.check_dynamic_key(&key, &context, parent, id);
            let access = self.member_access(parent, id, key.clone(), receiver, context.clone());
            self.push_access(access, node);
            self.check_deep_mutation(parent, id, &key, receiver, &context);
            return;
        }

        match self.kind(parent) {
            AstKind::VariableDeclarator(d) if d.init.as_ref().map(GetSpan::span) == Some(r_span) => {
                if let BindingPattern::ObjectPattern(pattern) = &d.id {
                    for prop in &pattern.properties {
                        let key = property_key(&prop.key, prop.computed);
                        self.destructure(key, prop.span, id, receiver, &context, node);
                    }
                    if let Some(rest) = &pattern.rest {
                        self.rest_escape(rest.span, id, &name);
                    }
                    return;
                }
            }
            AstKind::AssignmentExpression(a) if a.right.span() == r_span => {
                if let AssignmentTarget::ObjectAssignmentTarget(target) = &a.left {
                    for prop in &target.properties {
                        match prop {
                            AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(p) => {
                                let key = AccessKey::Static { name: p.binding.name.as_str().to_string() };
                                self.destructure(key, p.span, id, receiver, &context, node);
                            }
                            AssignmentTargetProperty::AssignmentTargetPropertyProperty(p) => {
                                let key = property_key(&p.name, p.computed);
                                self.destructure(key, p.span, id, receiver, &context, node);
                            }
                        }
                    }
                    if let Some(rest) = &target.rest {
                        self.rest_escape(rest.span, id, &name);
                    }
                    return;
                }
            }
            _ => {}
        }

        if self.is_harmless_use(parent) {
            return;
        }
        match self.kind(parent) {
            AstKind::BinaryExpression(b) if b.operator == BinaryOperator::In && b.right.span() == r_span => {
                let s = self.span(parent);
                self.diagnose(
                    "unsupported-operation",
                    "error",
                    format!("The \"in\" operator on observable \"{name}\" is not supported."),
                    s,
                    vec![id.into()],
                );
                return;
            }
            AstKind::ForInStatement(f) if f.right.span() == r_span => {
                let s = self.span(r);
                self.diagnose(
                    "unsupported-operation",
                    "error",
                    format!("Enumerating observable \"{name}\" with for...in is not supported."),
                    s,
                    vec![id.into()],
                );
                return;
            }
            AstKind::CallExpression(c) if c.arguments.iter().any(|a| a.span() == r_span) => {
                if let Expression::StaticMemberExpression(m) = &c.callee
                    && let Expression::Identifier(object) = &m.object
                    && object.name.as_str() == "Object"
                    && OBJECT_ENUMERATORS.contains(&m.property.name.as_str())
                    && self.scoping.get_reference(object.reference_id()).symbol_id().is_none()
                {
                    let s = self.span(parent);
                    self.diagnose(
                        "unsupported-operation",
                        "error",
                        format!("Object.{}() on observable \"{name}\" is not supported.", m.property.name.as_str()),
                        s,
                        vec![id.into()],
                    );
                    return;
                }
            }
            _ => {}
        }

        let s = self.span(r);
        let why = self.describe_escape(parent, r_span);
        self.diagnose(
            "observable-escape",
            "error",
            format!("Observable \"{name}\" escapes analysis ({why}); accesses through other references are not tracked."),
            s,
            vec![id.into()],
        );
    }

    fn classify_computed_reference(&mut self, node: NodeId, id: &str) {
        let name = self.reference_name(node);
        let r = self.outer(node);
        let r_span = self.node_span(r);
        let Some(parent) = self.parent(r) else { return };

        if let Some(key) = self.member_key_if_object(parent, r_span) {
            let member = self.outer(parent);
            let member_span = self.node_span(member);
            let call = self.parent(member).filter(
                |p| matches!(self.kind(*p), AstKind::CallExpression(c) if c.callee.span() == member_span),
            );
            if let (AccessKey::Static { name: key }, Some(call)) = (&key, call)
                && key == "get"
            {
                let context = self.context_of(node);
                let span = self.span(call);
                self.push_access(
                    ir::Access::ComputedRead { id: String::new(), computed: id.into(), context, span },
                    node,
                );
                return;
            }
            let s = self.span(parent);
            self.diagnose(
                "unsupported-operation",
                "error",
                format!("Only {name}.get() is supported on a computed."),
                s,
                vec![id.into()],
            );
            return;
        }
        if self.is_harmless_use(parent) {
            return;
        }
        let s = self.span(r);
        let why = self.describe_escape(parent, r_span);
        self.diagnose(
            "observable-escape",
            "error",
            format!("Computed \"{name}\" escapes analysis ({why}); reads through other references are not tracked."),
            s,
            vec![id.into()],
        );
    }

    fn destructure(
        &mut self,
        key: AccessKey,
        span: oxc_span::Span,
        id: &str,
        receiver: &'static str,
        ctx: &Context,
        at: NodeId,
    ) {
        let span = self.span_of(span);
        if key == AccessKey::Dynamic {
            self.dynamic_key_diagnostic(ctx, span, id);
        }
        let access = ir::Access::Read {
            id: String::new(),
            observable: id.into(),
            key,
            receiver,
            context: ctx.clone(),
            span,
            via: "destructure",
            path: vec![],
            called: false,
        };
        self.push_access(access, at);
    }

    fn rest_escape(&mut self, span: oxc_span::Span, id: &str, name: &str) {
        let s = self.span_of(span);
        self.diagnose(
            "observable-escape",
            "error",
            format!("Rest element copies every property of observable \"{name}\"; this is not tracked."),
            s,
            vec![id.into()],
        );
    }

    fn push_access(&mut self, access: ir::Access, at: NodeId) {
        self.pending.push(access);
        self.pending_fns.push(self.enclosing_function(at));
    }

    fn member_access(
        &self,
        member: NodeId,
        observable: &str,
        key: AccessKey,
        receiver: &'static str,
        context: Context,
    ) -> ir::Access {
        let m = self.outer(member);
        let m_span = self.node_span(m);
        let span = self.span(member);
        let write = |operator: String, reads_previous: bool| ir::Access::Write {
            id: String::new(),
            observable: observable.into(),
            key: key.clone(),
            receiver,
            context: context.clone(),
            span,
            operator,
            reads_previous,
        };
        if let Some(parent) = self.parent(m) {
            match self.kind(parent) {
                AstKind::AssignmentExpression(a) if a.left.span() == m_span => {
                    return write(a.operator.as_str().to_string(), a.operator != AssignmentOperator::Assign);
                }
                AstKind::UpdateExpression(u) => return write(u.operator.as_str().to_string(), true),
                AstKind::UnaryExpression(u) if u.operator == UnaryOperator::Delete => {
                    return ir::Access::Delete {
                        id: String::new(),
                        observable: observable.into(),
                        key: key.clone(),
                        receiver,
                        context: context.clone(),
                        span,
                    };
                }
                AstKind::ForInStatement(f) if f.left.span() == m_span => return write("=".into(), false),
                AstKind::ForOfStatement(f) if f.left.span() == m_span => return write("=".into(), false),
                AstKind::ArrayAssignmentTarget(_) | AstKind::AssignmentTargetRest(_) => {
                    return write("=".into(), false);
                }
                AstKind::AssignmentTargetWithDefault(t) if t.binding.span() == m_span => {
                    return write("=".into(), false);
                }
                AstKind::AssignmentTargetPropertyProperty(t) if t.binding.span() == m_span => {
                    return write("=".into(), false);
                }
                _ => {}
            }
        }
        let called = self
            .parent(m)
            .is_some_and(|p| matches!(self.kind(p), AstKind::CallExpression(c) if c.callee.span() == m_span));
        ir::Access::Read {
            id: String::new(),
            observable: observable.into(),
            key,
            receiver,
            context,
            span,
            via: "member",
            path: self.read_path(m),
            called,
        }
    }

    fn read_path(&self, member: NodeId) -> Vec<AccessKey> {
        let mut path = vec![];
        let mut current = member;
        while let Some(parent) = self.parent(current) {
            let Some(key) = self.member_key_if_object(parent, self.node_span(current)) else { break };
            let dynamic = key == AccessKey::Dynamic;
            path.push(key);
            if dynamic {
                break;
            }
            current = self.outer(parent);
        }
        path
    }

    /// If `node` is a member expression whose object spans `object`, its key.
    fn member_key_if_object(&self, node: NodeId, object: oxc_span::Span) -> Option<AccessKey> {
        match self.kind(node) {
            AstKind::StaticMemberExpression(m) if m.object.span() == object => {
                Some(AccessKey::Static { name: m.property.name.as_str().to_string() })
            }
            AstKind::ComputedMemberExpression(m) if m.object.span() == object => Some(computed_key(&m.expression)),
            AstKind::PrivateFieldExpression(m) if m.object.span() == object => Some(AccessKey::Dynamic),
            _ => None,
        }
    }

    fn member_key(&self, node: NodeId) -> AccessKey {
        match self.kind(node) {
            AstKind::StaticMemberExpression(m) => AccessKey::Static { name: m.property.name.as_str().to_string() },
            AstKind::ComputedMemberExpression(m) => computed_key(&m.expression),
            _ => AccessKey::Dynamic,
        }
    }

    fn check_deep_mutation(
        &mut self,
        member: NodeId,
        observable: &str,
        key: &AccessKey,
        receiver: &'static str,
        ctx: &Context,
    ) {
        let first = self.outer(member);
        let mut top = first;
        while let Some(parent) = self.parent(top) {
            if self.member_key_if_object(parent, self.node_span(top)).is_none() {
                break;
            }
            top = self.outer(parent);
        }
        if top == first {
            return;
        }
        // Deep (default) and shallow properties make nested objects, arrays, Maps and Sets
        // observable; only `observable.ref` / `observable.struct` store values as they are.
        let Some(modifier) = self.ref_modifier(observable, key) else { return };
        let name = match key {
            AccessKey::Static { name } => name.clone(),
            AccessKey::Dynamic => "<dynamic>".into(),
        };
        if !matches!(self.member_access(top, observable, key.clone(), receiver, ctx.clone()), ir::Access::Read { .. }) {
            let s = self.span(top);
            self.diagnose(
                "deep-mutation",
                "warning",
                format!(
                    "\"{name}\" is observable.{modifier}, so its value is not observable; this mutation is not tracked."
                ),
                s,
                vec![observable.into()],
            );
            return;
        }
        let Some(call) = self.parent(top) else { return };
        let AstKind::CallExpression(c) = self.kind(call) else { return };
        if c.callee.span() != self.node_span(top) {
            return;
        }
        let kind = self.property_value_kind(observable, key);
        let mutates = kind == Some("object")
            || (kind == Some("array")
                && match self.member_key(top) {
                    AccessKey::Dynamic => true,
                    AccessKey::Static { name } => MUTATING_ARRAY_METHODS.contains(&name.as_str()),
                });
        if mutates {
            let s = self.span(call);
            self.diagnose(
                "deep-mutation",
                "warning",
                format!(
                    "\"{name}\" is observable.{modifier}, so its value is not observable; this method call may mutate it without being tracked."
                ),
                s,
                vec![observable.into()],
            );
        }
    }

    /// `"ref"` / `"struct"` if the property stores values as they are (not made observable).
    fn ref_modifier(&self, observable: &str, key: &AccessKey) -> Option<&'static str> {
        let AccessKey::Static { name } = key else { return None };
        let obs = self.observables.get(id_index(observable))?;
        let Shape::Object { members, .. } = &obs.shape else { return None };
        match members.iter().find(|m| &m.key == name && !m.is_static)?.annotation {
            Some(Annotation::Observable { modifier }) if matches!(modifier, "ref" | "struct") => Some(modifier),
            _ => None,
        }
    }

    fn property_value_kind(&self, observable: &str, key: &AccessKey) -> Option<&'static str> {
        let AccessKey::Static { name } = key else { return None };
        let obs = self.observables.get(id_index(observable))?;
        let Shape::Object { members, .. } = &obs.shape else { return None };
        members.iter().find(|m| &m.key == name && !m.is_static).map(|m| m.value_kind)
    }

    fn check_dynamic_key(&mut self, key: &AccessKey, ctx: &Context, node: NodeId, observable: &str) {
        if *key == AccessKey::Dynamic {
            let s = self.span(node);
            self.dynamic_key_diagnostic(ctx, s, observable);
        }
    }

    fn dynamic_key_diagnostic(&mut self, ctx: &Context, span: ir::Span, observable: &str) {
        let tracked = matches!(ctx, Context::Tracked { .. });
        self.diagnose(
            "dynamic-key",
            if tracked { "error" } else { "warning" },
            if tracked {
                "Dynamic property key inside a tracked function; the dependency cannot be determined statically.".into()
            } else {
                "Dynamic property key on an observable.".into()
            },
            span,
            vec![observable.into()],
        );
    }

    // -- context ----------------------------------------------------------------------

    fn context_of(&self, node: NodeId) -> Context {
        let mut crossed = false;
        for ancestor in self.nodes.ancestor_ids(node) {
            if let Some(role) = self.roles.get(&ancestor) {
                if !crossed {
                    let is_async = match self.kind(ancestor) {
                        AstKind::Function(f) => f.r#async,
                        AstKind::ArrowFunctionExpression(f) => f.r#async,
                        _ => false,
                    };
                    if !matches!(role, Role::Effect(_)) && is_async && self.is_after_await(node, ancestor) {
                        let within = match role {
                            Role::Tracked(by) | Role::Action(by) | Role::Effect(by) => by.clone(),
                        };
                        return Context::AfterAwait { within };
                    }
                    return match role {
                        Role::Tracked(by) => Context::Tracked { by: by.clone() },
                        Role::Effect(r) => Context::Effect { reaction: r.clone() },
                        Role::Action(a) => Context::Action { action: a.clone() },
                    };
                }
                return match role {
                    Role::Tracked(by) => Context::TrackedNested { by: by.clone() },
                    Role::Effect(r) => Context::Effect { reaction: r.clone() },
                    // A function nested in an action body may run after the action completes.
                    Role::Action(_) => Context::Untracked,
                };
            }
            if is_function(self.kind(ancestor)) {
                crossed = true;
            }
        }
        Context::Untracked
    }

    /// Whether code at `node` may run after an `await` in `function`.
    fn is_after_await(&self, node: NodeId, function: NodeId) -> bool {
        let Some(info) = self.fn_info.get(&function) else { return false };
        if info.awaits.is_empty() && info.for_await_right_ends.is_empty() {
            return false;
        }
        let start = self.node_span(node).start;
        let within = |inner: oxc_span::Span, outer: oxc_span::Span| inner.start >= outer.start && inner.end <= outer.end;
        if info.awaits.iter().any(|a| a.end <= start) || info.for_await_right_ends.iter().any(|end| *end <= start) {
            return true;
        }
        for ancestor in self.nodes.ancestor_ids(node) {
            if ancestor == function {
                break;
            }
            match self.kind(ancestor) {
                AstKind::AssignmentExpression(a) => {
                    let right = a.right.span();
                    if start < right.start && info.awaits.iter().any(|aw| within(*aw, right)) {
                        return true;
                    }
                }
                AstKind::ForStatement(_)
                | AstKind::ForInStatement(_)
                | AstKind::ForOfStatement(_)
                | AstKind::WhileStatement(_)
                | AstKind::DoWhileStatement(_) => {
                    let loop_span = self.node_span(ancestor);
                    if info.awaits.iter().any(|aw| within(*aw, loop_span)) {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }

    // -- finalize -----------------------------------------------------------------------

    fn finalize(&mut self) -> Vec<ir::Access> {
        let pending = std::mem::take(&mut self.pending);
        let fns = std::mem::take(&mut self.pending_fns);
        let mut indexed: Vec<(ir::Access, Option<NodeId>)> = pending.into_iter().zip(fns).collect();
        indexed.sort_by_key(|(a, _)| (a.span().start, a.span().end));
        let (mut accesses, fns): (Vec<ir::Access>, Vec<Option<NodeId>>) = indexed.into_iter().unzip();
        for (i, access) in accesses.iter_mut().enumerate() {
            access.set_id(format!("access:{i}"));
        }

        for access in &accesses {
            let target = access.target().to_string();
            let aid = access.id().to_string();
            match access.context().clone() {
                Context::Tracked { by } => {
                    if access.is_read() {
                        self.push_dependency(&by, aid);
                    } else {
                        self.diagnose(
                            "write-in-derivation",
                            "warning",
                            "Observable write inside a tracked function (computed / reaction data / autorun).".into(),
                            access.span(),
                            vec![target, by, aid],
                        );
                    }
                }
                Context::TrackedNested { by } => self.diagnose(
                    "untracked-nested-read",
                    "warning",
                    "Observable access inside a function nested in a tracked function; it is only tracked if the function runs during tracking.".into(),
                    access.span(),
                    vec![target, by, aid],
                ),
                Context::Action { action } if !access.is_read() => {
                    if let Some(a) = self.actions.get_mut(id_index(&action)) {
                        a.writes.push(aid);
                    }
                }
                Context::AfterAwait { within } => {
                    let tracked = !within.starts_with("action:");
                    if !access.is_read() {
                        self.diagnose(
                            "after-await",
                            "warning",
                            if tracked {
                                "Write after `await` in a tracked function.".into()
                            } else {
                                "Write after `await` runs outside the action; wrap it in runInAction().".into()
                            },
                            access.span(),
                            vec![target, within, aid],
                        );
                    } else if tracked {
                        self.diagnose(
                            "after-await",
                            "warning",
                            "Read after `await` in a tracked function is not tracked.".into(),
                            access.span(),
                            vec![target, within, aid],
                        );
                    }
                }
                _ => {}
            }
        }
        self.compute_indirect_dependencies(&accesses, &fns);
        accesses
    }

    fn push_dependency(&mut self, derivation: &str, access: String) {
        let index = id_index(derivation);
        if derivation.starts_with("reaction:") {
            self.reactions[index].dependencies.push(access);
        } else {
            self.computeds[index].dependencies.push(access);
        }
    }

    /// Follow calls from each tracked function into local functions and observable methods,
    /// recording the reads inside them as indirect dependencies. Also reports imports used in
    /// those functions, which per-module analysis cannot resolve.
    fn compute_indirect_dependencies(&mut self, accesses: &[ir::Access], fns: &[Option<NodeId>]) {
        let mut reads_by_fn: HashMap<NodeId, Vec<String>> = HashMap::new();
        for (access, function) in accesses.iter().zip(fns) {
            if let Some(function) = function
                && access.is_read()
            {
                reads_by_fn.entry(*function).or_default().push(access.id().to_string());
            }
        }

        for root in self.role_order.clone() {
            let Some(Role::Tracked(by)) = self.roles.get(&root).cloned() else { continue };
            let mut visited: Vec<NodeId> = vec![root];
            let mut seen: HashSet<NodeId> = HashSet::from([root]);
            let mut queue = vec![root];
            let mut reported: HashSet<SymbolId> = HashSet::new();
            while let Some(function) = queue.pop() {
                let (calls, identifiers) = match self.fn_info.get(&function) {
                    Some(info) => (info.calls.clone(), info.identifiers.clone()),
                    None => continue,
                };
                for call in calls {
                    if let Some(target) = self.resolve_call_target(call)
                        && seen.insert(target)
                    {
                        visited.push(target);
                        queue.push(target);
                    }
                }
                for ident in identifiers {
                    self.check_imported_reference(ident, &by, &mut reported);
                }
            }
            let mut indirect: Vec<String> = visited
                .iter()
                .filter(|f| **f != root)
                .flat_map(|f| reads_by_fn.get(f).cloned().unwrap_or_default())
                .collect();
            indirect.sort_by_key(|id| access_index(id));
            let index = id_index(&by);
            if by.starts_with("reaction:") {
                self.reactions[index].indirect_dependencies.extend(indirect);
            } else {
                self.computeds[index].indirect_dependencies.extend(indirect);
            }
        }
    }

    /// The function a call invokes, if it is a local function or a method of an observable.
    fn resolve_call_target(&self, call: NodeId) -> Option<NodeId> {
        let AstKind::CallExpression(c) = self.kind(call) else { return None };
        match &c.callee {
            Expression::Identifier(ident) => {
                let symbol = self.scoping.get_reference(ident.reference_id()).symbol_id()?;
                let decl = self.scoping.symbol_declaration(symbol);
                match self.kind(decl) {
                    AstKind::Function(f) if f.is_declaration() => Some(decl),
                    AstKind::VariableDeclarator(d) => {
                        let reassigned = self
                            .scoping
                            .get_resolved_reference_ids(symbol)
                            .iter()
                            .any(|r| self.scoping.get_reference(*r).is_write());
                        if reassigned {
                            return None;
                        }
                        match &d.init {
                            Some(Expression::ArrowFunctionExpression(f)) => Some(f.node_id()),
                            Some(Expression::FunctionExpression(f)) => Some(f.node_id()),
                            _ => None,
                        }
                    }
                    _ => None,
                }
            }
            Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_) => {
                let (object, key) = match &c.callee {
                    Expression::StaticMemberExpression(m) => {
                        (&m.object, AccessKey::Static { name: m.property.name.as_str().to_string() })
                    }
                    Expression::ComputedMemberExpression(m) => (&m.object, computed_key(&m.expression)),
                    _ => return None,
                };
                let AccessKey::Static { name } = key else { return None };
                let observable = match object {
                    Expression::ThisExpression(t) => {
                        self.this_owner(t.node_id()).and_then(|o| self.this_owners.get(&o).cloned())
                    }
                    Expression::Identifier(ident) => {
                        let symbol = self.scoping.get_reference(ident.reference_id()).symbol_id()?;
                        self.symbol_observable.get(&symbol).cloned()
                    }
                    _ => None,
                }?;
                let (node, untracked) = self.member_fns.get(&format!("{observable}|{name}"))?;
                (!untracked).then_some(*node)
            }
            _ => None,
        }
    }

    /// Report a member access / call on an import from another module, once per derivation.
    fn check_imported_reference(&mut self, ident: NodeId, derivation: &str, reported: &mut HashSet<SymbolId>) {
        let AstKind::IdentifierReference(id) = self.kind(ident) else { return };
        let Some(parent) = self.parent(ident) else { return };
        let used = match self.kind(parent) {
            AstKind::StaticMemberExpression(m) => m.object.span() == id.span,
            AstKind::ComputedMemberExpression(m) => m.object.span() == id.span,
            AstKind::PrivateFieldExpression(m) => m.object.span() == id.span,
            AstKind::CallExpression(c) => c.callee.span() == id.span,
            _ => false,
        };
        if !used {
            return;
        }
        let reference = self.scoping.get_reference(id.reference_id());
        if reference.is_type() || reference.flags().is_value_as_type() {
            return;
        }
        let Some(symbol) = reference.symbol_id() else { return };
        if reported.contains(&symbol) {
            return;
        }
        let spec = self.scoping.symbol_declaration(symbol);
        let spec_type = match self.kind(spec) {
            AstKind::ImportSpecifier(s) => s.import_kind.is_type(),
            AstKind::ImportDefaultSpecifier(_) | AstKind::ImportNamespaceSpecifier(_) => false,
            _ => return,
        };
        let Some(decl_id) = self.parent(spec) else { return };
        let AstKind::ImportDeclaration(decl) = self.kind(decl_id) else { return };
        let source = decl.source.value.display().to_string();
        if source == self.module_specifier || decl.import_kind.is_type() || spec_type {
            return;
        }
        reported.insert(symbol);
        let s = self.span_of(id.span);
        self.diagnose(
            "unresolved-import",
            "warning",
            format!(
                "\"{}\" is imported from \"{source}\" and used in a tracked function; whether it reads observables cannot be determined per module.",
                id.name.as_str()
            ),
            s,
            vec![derivation.into()],
        );
    }

    /// Entities are discovered in dependency order; reassign ids in source order and rewrite
    /// every cross-reference.
    fn renumber(&mut self, accesses: &mut [ir::Access]) {
        let obs = reorder(&mut self.observables, "observable", |o| match &o.target {
            Target::Class { class_span, .. } => class_span.start,
            Target::Object { .. } => o.span.start,
        });
        let comp = reorder(&mut self.computeds, "computed", |c| c.span.start);
        let act = reorder(&mut self.actions, "action", |a| a.span.start);
        let react = reorder(&mut self.reactions, "reaction", |r| r.span.start);
        let remap = |map: &HashMap<String, String>, id: &mut String| {
            if let Some(new) = map.get(id) {
                *id = new.clone();
            }
        };
        let any = |id: &mut String| {
            for map in [&obs, &comp, &act, &react] {
                if let Some(new) = map.get(id) {
                    *id = new.clone();
                    return;
                }
            }
        };

        for o in &mut self.observables {
            if let Shape::Object { members, .. } = &mut o.shape {
                for m in members {
                    if let Some(c) = &mut m.computed {
                        remap(&comp, c);
                    }
                    if let Some(a) = &mut m.action {
                        remap(&act, a);
                    }
                }
            }
        }
        for c in &mut self.computeds {
            if let ComputedSource::Getter { observable, .. } = &mut c.source {
                remap(&obs, observable);
            }
        }
        for a in &mut self.actions {
            if let ActionSource::Member { observable, .. } = &mut a.source {
                remap(&obs, observable);
            }
        }
        for access in accesses.iter_mut() {
            any(access.target_mut());
            match access.context_mut() {
                Context::Tracked { by } | Context::TrackedNested { by } => any(by),
                Context::Effect { reaction } => remap(&react, reaction),
                Context::Action { action } => remap(&act, action),
                Context::AfterAwait { within } => any(within),
                Context::Untracked => {}
            }
        }
        for d in &mut self.diagnostics {
            for id in &mut d.related {
                any(id);
            }
        }
    }

    // -- helpers ------------------------------------------------------------------------

    fn kind(&self, id: NodeId) -> AstKind<'a> {
        self.nodes.kind(id)
    }

    fn parent(&self, id: NodeId) -> Option<NodeId> {
        if matches!(self.kind(id), AstKind::Program(_)) {
            return None;
        }
        Some(self.nodes.parent_id(id))
    }

    fn node_span(&self, id: NodeId) -> oxc_span::Span {
        self.kind(id).span()
    }

    fn enclosing_function(&self, id: NodeId) -> Option<NodeId> {
        self.nodes.ancestor_ids(id).find(|a| is_function(self.kind(*a)))
    }

    /// Walk up through value-preserving wrappers (`as`, `!`, `satisfies`, parens, `?.` chains).
    fn outer(&self, id: NodeId) -> NodeId {
        let mut current = id;
        while let Some(parent) = self.parent(current) {
            let span = self.node_span(current);
            let wraps = match self.kind(parent) {
                AstKind::TSAsExpression(e) => e.expression.span() == span,
                AstKind::TSSatisfiesExpression(e) => e.expression.span() == span,
                AstKind::TSNonNullExpression(e) => e.expression.span() == span,
                AstKind::TSTypeAssertion(e) => e.expression.span() == span,
                AstKind::ParenthesizedExpression(e) => e.expression.span() == span,
                AstKind::ChainExpression(e) => e.expression.span() == span,
                _ => false,
            };
            if !wraps {
                break;
            }
            current = parent;
        }
        current
    }

    /// The class whose constructor directly contains `node` (arrow functions are transparent).
    fn enclosing_constructor_class(&self, node: NodeId) -> Option<NodeId> {
        for ancestor in self.nodes.ancestor_ids(node) {
            match self.kind(ancestor) {
                AstKind::ArrowFunctionExpression(_) => continue,
                AstKind::Function(_) => {
                    let method = self.parent(ancestor)?;
                    let AstKind::MethodDefinition(m) = self.kind(method) else { return None };
                    if m.kind != MethodDefinitionKind::Constructor {
                        return None;
                    }
                    let body = self.parent(method)?;
                    let class = self.parent(body)?;
                    return matches!(self.kind(class), AstKind::Class(_)).then_some(class);
                }
                _ => {}
            }
        }
        None
    }

    /// The object literal or class `this` refers to at `node`, if statically known.
    fn this_owner(&self, node: NodeId) -> Option<NodeId> {
        for ancestor in self.nodes.ancestor_ids(node) {
            match self.kind(ancestor) {
                AstKind::ArrowFunctionExpression(_) => continue,
                AstKind::PropertyDefinition(p) => {
                    return if p.r#static { None } else { self.parent(self.parent(ancestor)?) };
                }
                AstKind::AccessorProperty(p) => {
                    return if p.r#static { None } else { self.parent(self.parent(ancestor)?) };
                }
                AstKind::Function(f) => {
                    let parent = self.parent(ancestor)?;
                    return match self.kind(parent) {
                        AstKind::MethodDefinition(m) => {
                            if m.r#static {
                                None
                            } else {
                                self.parent(self.parent(parent)?)
                            }
                        }
                        AstKind::ObjectProperty(p) if p.value.span() == f.span => self.parent(parent),
                        _ => None,
                    };
                }
                AstKind::StaticBlock(_) | AstKind::Class(_) | AstKind::Program(_) => return None,
                _ => {}
            }
        }
        None
    }

    fn class_name(&self, class_id: NodeId, class: &Class) -> Option<String> {
        if let Some(id) = &class.id {
            return Some(id.name.as_str().to_string());
        }
        let parent = self.parent(class_id)?;
        if let AstKind::VariableDeclarator(d) = self.kind(parent)
            && let BindingPattern::BindingIdentifier(b) = &d.id
        {
            return Some(b.name.as_str().to_string());
        }
        None
    }

    /// The binding a class is reachable through in its enclosing scope.
    fn class_symbol(&self, class_id: NodeId, class: &Class) -> Option<SymbolId> {
        if class.is_declaration() {
            return class.id.as_ref().map(BindingIdentifier::symbol_id);
        }
        if class.id.is_some() {
            return None;
        }
        let parent = self.parent(class_id)?;
        if let AstKind::VariableDeclarator(d) = self.kind(parent)
            && let BindingPattern::BindingIdentifier(b) = &d.id
        {
            return Some(b.symbol_id());
        }
        None
    }

    /// Value references to a symbol, in source order: no type positions, no pure writes.
    fn value_refs(&self, symbol: SymbolId) -> Vec<NodeId> {
        let mut out: Vec<NodeId> = self
            .scoping
            .get_resolved_reference_ids(symbol)
            .iter()
            .map(|id| self.scoping.get_reference(*id))
            .filter(|r| !r.is_type() && !r.flags().is_value_as_type())
            .filter(|r| !(r.is_write() && !r.is_read()))
            .map(|r| r.node_id())
            .collect();
        out.sort_by_key(|id| self.node_span(*id).start);
        out
    }

    fn resolve_result_binding(&self, outer: NodeId) -> Option<(SymbolId, Binding)> {
        let parent = self.parent(outer)?;
        let outer_span = self.node_span(outer);
        let (symbol, name, kind) = match self.kind(parent) {
            AstKind::VariableDeclarator(d) if d.init.as_ref().map(GetSpan::span) == Some(outer_span) => {
                let BindingPattern::BindingIdentifier(b) = &d.id else { return None };
                let kind = match self.parent(parent).map(|p| self.kind(p)) {
                    Some(AstKind::VariableDeclaration(v)) => match v.kind {
                        VariableDeclarationKind::Let => "let",
                        VariableDeclarationKind::Var => "var",
                        _ => "const",
                    },
                    _ => "const",
                };
                (b.symbol_id(), b.name.as_str().to_string(), kind)
            }
            AstKind::AssignmentExpression(a)
                if a.operator == AssignmentOperator::Assign && a.right.span() == outer_span =>
            {
                let AssignmentTarget::AssignmentTargetIdentifier(ident) = &a.left else { return None };
                let symbol = self.scoping.get_reference(ident.reference_id()).symbol_id()?;
                (symbol, ident.name.as_str().to_string(), "assignment")
            }
            _ => return None,
        };
        let scope = if self.scoping.symbol_scope_id(symbol) == self.scoping.root_scope_id() { "module" } else { "local" };
        let exported = self.is_exported(symbol);
        Some((symbol, Binding { name, scope, declaration_kind: kind, exported }))
    }

    fn is_export_kind(&self, node: NodeId) -> bool {
        matches!(
            self.kind(node),
            AstKind::ExportDeclaration(_) | AstKind::ExportNamedDeclaration(_) | AstKind::ExportDefaultDeclaration(_)
        )
    }

    fn is_declared_exported(&self, symbol: SymbolId) -> bool {
        let decl = self.scoping.symbol_declaration(symbol);
        let p1 = self.parent(decl);
        let p2 = p1.and_then(|p| self.parent(p));
        [p1, p2].into_iter().flatten().any(|p| self.is_export_kind(p))
    }

    fn is_exported(&self, symbol: SymbolId) -> bool {
        self.is_declared_exported(symbol)
            || self.scoping.get_resolved_reference_ids(symbol).iter().any(|id| {
                let node = self.scoping.get_reference(*id).node_id();
                self.parent(node).is_some_and(|p| matches!(self.kind(p), AstKind::ExportSpecifier(_)))
            })
    }

    fn is_harmless_use(&self, parent: NodeId) -> bool {
        match self.kind(parent) {
            AstKind::ExpressionStatement(_) => true,
            AstKind::UnaryExpression(u) => matches!(u.operator, UnaryOperator::Typeof | UnaryOperator::Void),
            AstKind::BinaryExpression(b) => b.operator.is_equality(),
            _ => false,
        }
    }

    fn reference_name(&self, node: NodeId) -> String {
        match self.kind(node) {
            AstKind::IdentifierReference(id) => id.name.as_str().to_string(),
            AstKind::ThisExpression(_) => "this".into(),
            _ => "<observable>".into(),
        }
    }

    fn describe_escape(&self, parent: NodeId, r: oxc_span::Span) -> String {
        match self.kind(parent) {
            AstKind::CallExpression(_) | AstKind::NewExpression(_) => "passed as an argument".into(),
            AstKind::ReturnStatement(_) | AstKind::ArrowFunctionExpression(_) => "returned".into(),
            AstKind::ExportSpecifier(_) | AstKind::ExportDefaultDeclaration(_) => "exported".into(),
            AstKind::SpreadElement(_) => "spread".into(),
            AstKind::Class(c) if c.heritage.as_ref().map(|h| h.expression.span()) == Some(r) => "subclassed".into(),
            AstKind::VariableDeclarator(_) | AstKind::AssignmentExpression(_) => "aliased".into(),
            AstKind::ArrayExpression(_) | AstKind::ObjectProperty(_) => "stored in another value".into(),
            AstKind::ForOfStatement(f) if f.right.span() == r => "iterated".into(),
            other => format!("used in {}", other.debug_name()),
        }
    }

    fn span(&self, id: NodeId) -> ir::Span {
        self.span_of(self.node_span(id))
    }

    fn span_of(&self, span: oxc_span::Span) -> ir::Span {
        let start = self.utf16[span.start as usize];
        let end = self.utf16[span.end as usize];
        ir::Span { start, end, loc: ir::Loc { start: self.position(start), end: self.position(end) } }
    }

    fn position(&self, offset: u32) -> ir::Position {
        let line = match self.line_starts.binary_search(&offset) {
            Ok(i) => i,
            Err(i) => i - 1,
        };
        ir::Position { line: line as u32 + 1, column: offset - self.line_starts[line] }
    }

    fn diagnose(&mut self, code: &'static str, severity: &'static str, message: String, span: ir::Span, related: Vec<String>) {
        self.diagnostics.push(ir::Diagnostic { kind: "Diagnostic", code, severity, message, span, related });
    }
}

// -----------------------------------------------------------------------------------------

/// Sort by `key` (stable), reassign `{prefix}:{index}` ids in place, and return old -> new.
fn reorder<T, F>(items: &mut [T], prefix: &str, key: F) -> HashMap<String, String>
where
    T: HasId,
    F: Fn(&T) -> u32,
{
    items.sort_by_key(|item| key(item));
    let mut map = HashMap::new();
    for (i, item) in items.iter_mut().enumerate() {
        let new = format!("{prefix}:{i}");
        map.insert(item.id().to_string(), new.clone());
        item.set_id(new);
    }
    map
}

trait HasId {
    fn id(&self) -> &str;
    fn set_id(&mut self, id: String);
}

macro_rules! has_id {
    ($($t:ty),*) => {$(
        impl HasId for $t {
            fn id(&self) -> &str { &self.id }
            fn set_id(&mut self, id: String) { self.id = id; }
        }
    )*};
}
has_id!(ir::Observable, ir::Computed, ir::Action, ir::Reaction);

fn is_function(kind: AstKind) -> bool {
    matches!(kind, AstKind::Function(_) | AstKind::ArrowFunctionExpression(_))
}

fn access_index(id: &str) -> usize {
    id_index(id)
}

/// The numeric part of an id (`"reaction:3"` -> 3). Before renumbering, an entity's id number
/// is its index in its list.
fn id_index(id: &str) -> usize {
    id.rsplit(':').next().and_then(|n| n.parse().ok()).unwrap_or(usize::MAX)
}

/// Byte offset -> UTF-16 offset table, and UTF-16 line starts (JS strings are UTF-16).
fn utf16_index(source: &str) -> (Vec<u32>, Vec<u32>) {
    let mut map = vec![0u32; source.len() + 1];
    let mut lines = vec![0u32];
    let mut offset = 0u32;
    let mut chars = source.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        for b in 0..c.len_utf8() {
            map[i + b] = offset;
        }
        offset += c.len_utf16() as u32;
        if c == '\n' || (c == '\r' && chars.peek().is_none_or(|(_, n)| *n != '\n')) {
            lines.push(offset);
        }
    }
    map[source.len()] = offset;
    (map, lines)
}

fn param_count(params: &FormalParameters) -> u32 {
    (params.items.len() + usize::from(params.rest.is_some())) as u32
}

fn js_number_string(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 { format!("{}", v as i64) } else { format!("{v}") }
}

fn computed_key(expr: &Expression) -> AccessKey {
    match expr {
        Expression::StringLiteral(s) => AccessKey::Static { name: s.value.display().to_string() },
        Expression::NumericLiteral(n) => AccessKey::Static { name: js_number_string(n.value) },
        Expression::TemplateLiteral(t) if t.expressions.is_empty() && t.quasis.len() == 1 => AccessKey::Static {
            name: t.quasis[0].value.cooked.map(|c| c.display().to_string()).unwrap_or_default(),
        },
        _ => AccessKey::Dynamic,
    }
}

fn property_key(key: &PropertyKey, computed: bool) -> AccessKey {
    match key {
        PropertyKey::StaticIdentifier(id) if !computed => AccessKey::Static { name: id.name.as_str().to_string() },
        PropertyKey::PrivateIdentifier(_) => AccessKey::Dynamic,
        other => other.as_expression().map_or(AccessKey::Dynamic, computed_key),
    }
}

fn value_kind(expr: &Expression) -> &'static str {
    match expr {
        Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::BigIntLiteral(_) => "primitive",
        Expression::TemplateLiteral(t) if t.expressions.is_empty() => "primitive",
        Expression::Identifier(id) if id.name.as_str() == "undefined" => "primitive",
        Expression::UnaryExpression(u) if matches!(u.argument, Expression::NumericLiteral(_)) => "primitive",
        Expression::ObjectExpression(_) => "object",
        Expression::ArrayExpression(_) => "array",
        Expression::FunctionExpression(f) if f.generator => "generator",
        Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_) => "function",
        Expression::TSAsExpression(e) => value_kind(&e.expression),
        Expression::TSSatisfiesExpression(e) => value_kind(&e.expression),
        Expression::TSNonNullExpression(e) => value_kind(&e.expression),
        Expression::TSTypeAssertion(e) => value_kind(&e.expression),
        Expression::ParenthesizedExpression(e) => value_kind(&e.expression),
        _ => "unknown",
    }
}

/// The annotation `observable()` / `makeAutoObservable()` infer for a member.
fn infer_annotation(m: &RawMember, defaults: Defaults) -> Annotation {
    if m.member_kind == "getter" {
        return Annotation::Computed { modifier: "default" };
    }
    if m.value_kind == "generator" {
        return Annotation::Flow { bound: defaults.auto_bind };
    }
    if m.member_kind == "method" || m.value_kind == "function" {
        return Annotation::AutoAction { bound: defaults.auto_bind };
    }
    Annotation::Observable { modifier: if defaults.deep { "deep" } else { "ref" } }
}

fn option_value(expr: &Expression) -> Value {
    match expr {
        Expression::StringLiteral(s) => json!({ "kind": "literal", "value": s.value.display().to_string() }),
        Expression::NumericLiteral(n) => json!({ "kind": "literal", "value": n.value }),
        Expression::BooleanLiteral(b) => json!({ "kind": "literal", "value": b.value }),
        Expression::NullLiteral(_) => json!({ "kind": "literal", "value": null }),
        _ => json!({ "kind": "unknown" }),
    }
}

/// `new Map(...)` / `new Set(...)`: the kind of observable collection it makes.
fn collection_kind(arg: &Argument<'_>) -> Option<&'static str> {
    let Argument::NewExpression(n) = arg else { return None };
    let Expression::Identifier(id) = &n.callee else { return None };
    match id.name.as_str() {
        "Map" => Some("map"),
        "Set" => Some("set"),
        _ => None,
    }
}

fn observable_value_key(kind: &str) -> &'static str {
    match kind {
        "array" => "observable.array",
        "box" => "observable.box",
        "map" => "observable.map",
        _ => "observable.set",
    }
}
