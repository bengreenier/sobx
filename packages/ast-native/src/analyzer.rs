//! SPIKE: Rust port of the analyzer slice (imports, `observable()` objects, property
//! accesses, `reaction` / `autorun`, and their diagnostics), built on oxc_parser +
//! oxc_semantic. Produces the same IR as `packages/ast/src/analyze.ts` for that slice.

use std::collections::{HashMap, HashSet};

use oxc_ast::{AstKind, ast::*};
use oxc_semantic::{AstNodes, NodeId, Scoping, Semantic, SymbolId};
use oxc_span::GetSpan;
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator, UnaryOperator};
use serde_json::{Map, Value, json};

use crate::ir::{self, AccessKey, Annotation, Binding, Context, FunctionRef, Member, Options, Shape};

const MODELED: &[&str] = &[
    "action",
    "autorun",
    "computed",
    "makeAutoObservable",
    "makeObservable",
    "observable",
    "reaction",
    "runInAction",
];
const UNMODELED: &[&str] = &["flow", "when"];
const ANNOTATING: &[&str] = &["observable", "makeObservable", "makeAutoObservable"];
const OBJECT_ENUMERATORS: &[&str] = &["keys", "values", "entries", "assign", "getOwnPropertyNames", "freeze"];
const MUTATING_ARRAY_METHODS: &[&str] =
    &["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"];

fn known_api(name: &str) -> Option<&'static str> {
    MODELED.iter().chain(UNMODELED.iter()).find(|api| **api == name).copied()
}

#[derive(Clone)]
enum Role {
    Tracked(String),
    Effect(String),
}

pub struct Analyzer<'s, 'a> {
    source: &'a str,
    program: &'a Program<'a>,
    nodes: &'s AstNodes<'a>,
    scoping: &'s Scoping,
    module_specifier: String,
    filename: Option<String>,
    utf16: Vec<u32>,
    line_starts: Vec<u32>,

    imports: Vec<ir::Import>,
    observables: Vec<ir::Observable>,
    reactions: Vec<ir::Reaction>,
    unsupported: Vec<ir::UnsupportedUsage>,
    diagnostics: Vec<ir::Diagnostic>,
    pending: Vec<ir::Access>,

    api_refs: HashMap<NodeId, &'static str>,
    calls: HashMap<&'static str, Vec<NodeId>>,
    roles: HashMap<NodeId, Role>,
    observable_symbols: Vec<(SymbolId, String, String)>,
    symbol_observable: HashMap<SymbolId, String>,
    reported: HashSet<NodeId>,
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
            source,
            program,
            nodes: semantic.nodes(),
            scoping: semantic.scoping(),
            module_specifier,
            filename,
            utf16,
            line_starts,
            imports: vec![],
            observables: vec![],
            reactions: vec![],
            unsupported: vec![],
            diagnostics: vec![],
            pending: vec![],
            api_refs: HashMap::new(),
            calls: HashMap::new(),
            roles: HashMap::new(),
            observable_symbols: vec![],
            symbol_observable: HashMap::new(),
            reported: HashSet::new(),
        }
    }

    pub fn run(mut self) -> ir::Module {
        let _ = self.source;
        self.collect_imports();
        for call in self.sorted(&["observable"]) {
            self.visit_observable_call(call);
        }
        for call in self.sorted(&["reaction", "autorun"]) {
            self.visit_reaction_call(call);
        }
        for (symbol, id, name) in self.observable_symbols.clone() {
            for node in self.value_refs(symbol) {
                self.classify_reference(node, &id, &name);
            }
        }
        let accesses = self.finalize();
        self.diagnostics
            .sort_by(|a, b| (a.span.start, a.span.end, a.code).cmp(&(b.span.start, b.span.end, b.code)));
        ir::Module {
            kind: "Module",
            ir_version: ir::IR_VERSION,
            filename: self.filename,
            module_specifier: self.module_specifier,
            imports: self.imports,
            observables: self.observables,
            computeds: vec![],
            accesses,
            reactions: self.reactions,
            actions: vec![],
            unsupported: self.unsupported,
            diagnostics: self.diagnostics,
        }
    }

    // -- imports --------------------------------------------------------------

    fn collect_imports(&mut self) {
        let mut refs: Vec<(NodeId, Option<&'static str>, String)> = vec![];
        for stmt in &self.program.body {
            let Statement::ImportDeclaration(decl) = stmt else { continue };
            if decl.source.value.as_str() != Some(self.module_specifier.as_str()) {
                continue;
            }
            if decl.import_kind.is_type() {
                continue;
            }
            let Some(specifiers) = &decl.specifiers else { continue };
            for spec in specifiers {
                match spec {
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                        let local = s.local.name.as_str().to_string();
                        let span = self.span_of(s.span);
                        self.diagnose(
                            "namespace-import",
                            "error",
                            format!(
                                "Namespace import \"{local}\" from \"{}\" is not analyzed; use named imports.",
                                self.module_specifier
                            ),
                            span,
                            vec![],
                        );
                        self.imports.push(ir::Import::NamespaceImport { local, span });
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                        let local = s.local.name.as_str().to_string();
                        let span = self.span_of(s.span);
                        self.diagnose(
                            "default-import",
                            "error",
                            format!(
                                "Default import \"{local}\" from \"{}\" is not analyzed; use named imports.",
                                self.module_specifier
                            ),
                            span,
                            vec![],
                        );
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
                        if api.is_none() {
                            self.diagnose(
                                "unknown-import",
                                "warning",
                                format!(
                                    "\"{imported}\" is not a known export of \"{}\".",
                                    self.module_specifier
                                ),
                                span,
                                vec![],
                            );
                        }
                        self.imports.push(ir::Import::NamedImport {
                            imported,
                            local: local.clone(),
                            api,
                            span,
                        });
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

    fn classify_api_reference(&mut self, node: NodeId, api: Option<&'static str>, local: &str) {
        let mut expr = node;
        let mut member_name: Option<String> = None;
        let parent = self.parent(node);
        if let Some(p) = parent
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

        let Some(api) = api.filter(|a| !UNMODELED.contains(a)) else {
            self.unsupported.push(ir::UnsupportedUsage {
                kind: "UnsupportedUsage",
                api,
                local: local.to_string(),
                span,
            });
            if let Some(api) = api {
                self.diagnose(
                    "unsupported-api",
                    "error",
                    format!("\"{api}\" is not supported by sobx yet."),
                    span,
                    vec![],
                );
            }
            return;
        };
        if self.is_annotation_position(call.unwrap_or(expr)) {
            return;
        }
        if let Some(member) = member_name {
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
                format!(
                    "\"{local}\" must be called directly or used as an annotation; other uses cannot be analyzed."
                ),
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
                let Expression::Identifier(callee) = &c.callee else { return false };
                self.api_refs.get(&callee.node_id()).is_some_and(|api| ANNOTATING.contains(api))
            }
            _ => false,
        }
    }

    fn sorted(&self, apis: &[&str]) -> Vec<NodeId> {
        let mut out: Vec<NodeId> =
            apis.iter().flat_map(|api| self.calls.get(api).cloned().unwrap_or_default()).collect();
        out.sort_by_key(|id| self.node_span(*id).start);
        out
    }

    // -- observable() -----------------------------------------------------------

    fn visit_observable_call(&mut self, call_id: NodeId) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let id = format!("observable:{}", self.observables.len());
        let span = self.span(call_id);
        let first = call.arguments.first();
        if first.is_none_or(|a| matches!(a, Argument::SpreadElement(_))) {
            self.diagnose(
                "invalid-arguments",
                "error",
                "observable() expects an initial value as its first argument.".into(),
                span,
                vec![],
            );
        }
        let shape = match first {
            Some(Argument::ObjectExpression(object)) => self.object_shape(object, &id),
            _ => Shape::Unknown,
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
                    format!(
                        "Observable \"{}\" is exported; accesses in other modules are not tracked.",
                        binding.name
                    ),
                    ident,
                    vec![id.clone()],
                );
            }
        } else {
            self.diagnose(
                "unbound-observable",
                "error",
                "observable() result must be stored in a variable to be analyzed.".into(),
                span,
                vec![id.clone()],
            );
        }
        let options = call.arguments.get(2).map(|a| self.options(a));
        self.observables.push(ir::Observable {
            kind: "Observable",
            id,
            source: "observable",
            target: "object",
            binding: resolved.map(|(_, b)| b),
            shape,
            options,
            span,
        });
    }

    fn object_shape(&mut self, object: &ObjectExpression<'a>, observable: &str) -> Shape {
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
            let member_kind = if p.kind == PropertyKind::Get {
                "getter"
            } else if p.method {
                "method"
            } else {
                "field"
            };
            let value_kind = match member_kind {
                "getter" => "getter",
                "method" => match &p.value {
                    Expression::FunctionExpression(f) if f.generator => "generator",
                    _ => "function",
                },
                _ => value_kind(&p.value),
            };
            let span = self.span_of(p.span);
            if value_kind == "generator" {
                self.diagnose(
                    "unsupported-api",
                    "error",
                    format!(
                        "\"{name}\" is a generator and would be inferred as a flow, which is not supported by sobx yet."
                    ),
                    span,
                    vec![observable.to_string()],
                );
            }
            members.push(Member {
                key: name,
                member_kind,
                value_kind,
                is_static: false,
                accessor: false,
                annotation: Some(infer_annotation(member_kind, value_kind)),
                annotation_source: Some("inferred"),
                computed: None,
                action: None,
                span,
            });
        }
        Shape::Object { members, open }
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
        let scope = if self.scoping.symbol_scope_id(symbol) == self.scoping.root_scope_id() {
            "module"
        } else {
            "local"
        };
        let exported = self.is_exported(symbol);
        Some((symbol, Binding { name, scope, declaration_kind: kind, exported }))
    }

    fn register_observable(&mut self, symbol: SymbolId, binding: &Binding, outer: NodeId, id: &str) {
        let assignment = self
            .parent(outer)
            .filter(|p| matches!(self.kind(*p), AstKind::AssignmentExpression(_)));
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
                vec![id.to_string()],
            );
            return;
        }
        self.symbol_observable.insert(symbol, id.to_string());
        self.observable_symbols.push((symbol, id.to_string(), binding.name.clone()));
        let name = self.scoping.symbol_name(symbol).to_string();
        for &rid in self.scoping.get_resolved_reference_ids(symbol) {
            let reference = self.scoping.get_reference(rid);
            if !reference.is_write() {
                continue;
            }
            let ident = reference.node_id();
            let violation = self.parent(ident).unwrap_or(ident);
            if Some(violation) == assignment || self.reported.contains(&violation) {
                continue;
            }
            self.reported.insert(violation);
            let s = self.span(violation);
            self.diagnose(
                "observable-reassigned",
                "error",
                format!("\"{name}\" is reassigned; references may not point at the observable."),
                s,
                vec![id.to_string()],
            );
        }
    }

    // -- reaction() / autorun() ---------------------------------------------------

    fn visit_reaction_call(&mut self, call_id: NodeId) {
        let AstKind::CallExpression(call) = self.kind(call_id) else { return };
        let Expression::Identifier(callee) = &call.callee else { return };
        let api = *self.api_refs.get(&callee.node_id()).unwrap_or(&"reaction");
        let span = self.span(call_id);
        let id = format!("reaction:{}", self.reactions.len());
        let disposer_used = !self
            .parent(self.outer(call_id))
            .is_some_and(|p| matches!(self.kind(p), AstKind::ExpressionStatement(_)));
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
            options,
            dependencies: vec![],
            indirect_dependencies: vec![],
            disposer_used,
            span,
        });
    }

    fn opaque(&mut self, what: &str, span: ir::Span, id: &str) {
        self.diagnose(
            "opaque-function",
            "error",
            format!("{what} must be an inline function so its dependencies can be analyzed."),
            span,
            vec![id.to_string()],
        );
    }

    fn function_ref(&mut self, expr: &Expression<'a>, role: Role) -> FunctionRef {
        match expr {
            Expression::ArrowFunctionExpression(f) => {
                self.roles.insert(f.node_id(), role);
                FunctionRef::Inline {
                    params: param_count(&f.params),
                    is_async: f.r#async,
                    span: self.span_of(f.span),
                }
            }
            Expression::FunctionExpression(f) => {
                self.roles.insert(f.node_id(), role);
                FunctionRef::Inline {
                    params: param_count(&f.params),
                    is_async: f.r#async,
                    span: self.span_of(f.span),
                }
            }
            other => FunctionRef::Opaque { span: self.span_of(other.span()) },
        }
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
            let value = if p.method {
                json!({ "kind": "unknown" })
            } else {
                option_value(&p.value)
            };
            entries.insert(name, value);
        }
        Options::Object { entries, open }
    }

    // -- references ---------------------------------------------------------------

    fn classify_reference(&mut self, node: NodeId, id: &str, name: &str) {
        let r = self.outer(node);
        let r_span = self.node_span(r);
        let Some(parent) = self.parent(r) else { return };
        let context = self.context_of(node);

        let member_key = match self.kind(parent) {
            AstKind::StaticMemberExpression(m) if m.object.span() == r_span => {
                Some(AccessKey::Static { name: m.property.name.as_str().to_string() })
            }
            AstKind::ComputedMemberExpression(m) if m.object.span() == r_span => {
                Some(computed_key(&m.expression))
            }
            AstKind::PrivateFieldExpression(m) if m.object.span() == r_span => Some(AccessKey::Dynamic),
            _ => None,
        };
        if let Some(key) = member_key {
            self.check_dynamic_key(&key, &context, parent, id);
            let access = self.member_access(parent, id, key.clone(), context.clone());
            self.pending.push(access);
            self.check_deep_mutation(parent, id, &key, &context);
            return;
        }

        match self.kind(parent) {
            AstKind::VariableDeclarator(d) if d.init.as_ref().map(GetSpan::span) == Some(r_span) => {
                if let BindingPattern::ObjectPattern(pattern) = &d.id {
                    for prop in &pattern.properties {
                        self.destructure(&prop.key, prop.computed, prop.span, id, &context);
                    }
                    if let Some(rest) = &pattern.rest {
                        self.rest_escape(rest.span, id, name);
                    }
                    return;
                }
            }
            AstKind::AssignmentExpression(a) if a.right.span() == r_span => {
                if let AssignmentTarget::ObjectAssignmentTarget(target) = &a.left {
                    for prop in &target.properties {
                        match prop {
                            AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(p) => {
                                let key = PropertyKeyOwned::Name(p.binding.name.as_str().to_string());
                                self.destructure_key(key, p.span, id, &context);
                            }
                            AssignmentTargetProperty::AssignmentTargetPropertyProperty(p) => {
                                self.destructure(&p.name, p.computed, p.span, id, &context);
                            }
                        }
                    }
                    if let Some(rest) = &target.rest {
                        self.rest_escape(rest.span, id, name);
                    }
                    return;
                }
            }
            _ => {}
        }

        match self.kind(parent) {
            AstKind::ExpressionStatement(_) => return,
            AstKind::UnaryExpression(u)
                if matches!(u.operator, UnaryOperator::Typeof | UnaryOperator::Void) =>
            {
                return;
            }
            AstKind::BinaryExpression(b) if b.operator.is_equality() => return,
            AstKind::BinaryExpression(b) if b.operator == BinaryOperator::In && b.right.span() == r_span => {
                let s = self.span(parent);
                self.diagnose(
                    "unsupported-operation",
                    "error",
                    format!("The \"in\" operator on observable \"{name}\" is not supported."),
                    s,
                    vec![id.to_string()],
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
                    vec![id.to_string()],
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
                        format!(
                            "Object.{}() on observable \"{name}\" is not supported.",
                            m.property.name.as_str()
                        ),
                        s,
                        vec![id.to_string()],
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
            format!(
                "Observable \"{name}\" escapes analysis ({why}); accesses through other references are not tracked."
            ),
            s,
            vec![id.to_string()],
        );
    }

    fn destructure(&mut self, key: &PropertyKey<'a>, computed: bool, span: oxc_span::Span, id: &str, ctx: &Context) {
        let key = match property_key(key, computed) {
            AccessKey::Static { name } => PropertyKeyOwned::Name(name),
            AccessKey::Dynamic => PropertyKeyOwned::Dynamic,
        };
        self.destructure_key(key, span, id, ctx);
    }

    fn destructure_key(&mut self, key: PropertyKeyOwned, span: oxc_span::Span, id: &str, ctx: &Context) {
        let key = match key {
            PropertyKeyOwned::Name(name) => AccessKey::Static { name },
            PropertyKeyOwned::Dynamic => AccessKey::Dynamic,
        };
        let span = self.span_of(span);
        if key == AccessKey::Dynamic {
            self.dynamic_key_diagnostic(ctx, span, id);
        }
        self.pending.push(ir::Access::Read {
            id: String::new(),
            observable: id.to_string(),
            key,
            receiver: "binding",
            context: ctx.clone(),
            span,
            via: "destructure",
            path: vec![],
            called: false,
        });
    }

    fn rest_escape(&mut self, span: oxc_span::Span, id: &str, name: &str) {
        let s = self.span_of(span);
        self.diagnose(
            "observable-escape",
            "error",
            format!("Rest element copies every property of observable \"{name}\"; this is not tracked."),
            s,
            vec![id.to_string()],
        );
    }

    fn member_access(&self, member: NodeId, observable: &str, key: AccessKey, context: Context) -> ir::Access {
        let m = self.outer(member);
        let m_span = self.node_span(m);
        let span = self.span(member);
        let observable = observable.to_string();
        let write = |operator: String, reads_previous: bool| ir::Access::Write {
            id: String::new(),
            observable: observable.clone(),
            key: key.clone(),
            receiver: "binding",
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
                        observable: observable.clone(),
                        key: key.clone(),
                        receiver: "binding",
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
        let called = self.parent(m).is_some_and(
            |p| matches!(self.kind(p), AstKind::CallExpression(c) if c.callee.span() == m_span),
        );
        ir::Access::Read {
            id: String::new(),
            observable,
            key,
            receiver: "binding",
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

    fn check_deep_mutation(&mut self, member: NodeId, observable: &str, key: &AccessKey, ctx: &Context) {
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
        let name = match key {
            AccessKey::Static { name } => name.clone(),
            AccessKey::Dynamic => "<dynamic>".into(),
        };
        if !matches!(self.member_access(top, observable, key.clone(), ctx.clone()), ir::Access::Read { .. }) {
            let s = self.span(top);
            self.diagnose(
                "deep-mutation",
                "warning",
                format!("Mutation of a value nested in observable property \"{name}\" is not tracked."),
                s,
                vec![observable.to_string()],
            );
            return;
        }
        let Some(call) = self.parent(top) else { return };
        let AstKind::CallExpression(c) = self.kind(call) else { return };
        if c.callee.span() != self.node_span(top) {
            return;
        }
        let kind = self.property_value_kind(observable, key);
        let method = self.member_key(top);
        let mutates = kind == Some("object")
            || (kind == Some("array")
                && match &method {
                    AccessKey::Dynamic => true,
                    AccessKey::Static { name } => MUTATING_ARRAY_METHODS.contains(&name.as_str()),
                });
        if mutates {
            let s = self.span(call);
            self.diagnose(
                "deep-mutation",
                "warning",
                format!(
                    "Method call on {} nested in observable property \"{name}\" may mutate it; this is not tracked.",
                    kind.unwrap_or_default()
                ),
                s,
                vec![observable.to_string()],
            );
        }
    }

    fn property_value_kind(&self, observable: &str, key: &AccessKey) -> Option<&'static str> {
        let AccessKey::Static { name } = key else { return None };
        let obs = self.observables.iter().find(|o| o.id == observable)?;
        let Shape::Object { members, .. } = &obs.shape else { return None };
        members.iter().find(|m| &m.key == name).map(|m| m.value_kind)
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
                "Dynamic property key inside a tracked function; the dependency cannot be determined statically."
                    .into()
            } else {
                "Dynamic property key on an observable.".into()
            },
            span,
            vec![observable.to_string()],
        );
    }

    fn context_of(&self, node: NodeId) -> Context {
        let mut crossed = false;
        for ancestor in self.nodes.ancestor_ids(node) {
            if let Some(role) = self.roles.get(&ancestor) {
                return match (role, crossed) {
                    (Role::Tracked(by), false) => Context::Tracked { by: by.clone() },
                    (Role::Tracked(by), true) => Context::TrackedNested { by: by.clone() },
                    (Role::Effect(r), _) => Context::Effect { reaction: r.clone() },
                };
            }
            if matches!(self.kind(ancestor), AstKind::Function(_) | AstKind::ArrowFunctionExpression(_)) {
                crossed = true;
            }
        }
        Context::Untracked
    }

    fn finalize(&mut self) -> Vec<ir::Access> {
        let mut accesses = std::mem::take(&mut self.pending);
        accesses.sort_by_key(|a| (a.span().start, a.span().end));
        for (i, access) in accesses.iter_mut().enumerate() {
            access.set_id(format!("access:{i}"));
        }
        for access in &accesses {
            let is_read = matches!(access, ir::Access::Read { .. });
            match access.context() {
                Context::Tracked { by } => {
                    if is_read {
                        if let Some(r) = self.reactions.iter_mut().find(|r| &r.id == by) {
                            r.dependencies.push(access.id().to_string());
                        }
                    } else {
                        self.diagnose(
                            "write-in-derivation",
                            "warning",
                            "Observable write inside a tracked function (computed / reaction data / autorun).".into(),
                            access.span(),
                            vec![access.observable().to_string(), by.clone(), access.id().to_string()],
                        );
                    }
                }
                Context::TrackedNested { by } => {
                    self.diagnose(
                        "untracked-nested-read",
                        "warning",
                        "Observable access inside a function nested in a tracked function; it is only tracked if the function runs during tracking.".into(),
                        access.span(),
                        vec![access.observable().to_string(), by.clone(), access.id().to_string()],
                    );
                }
                _ => {}
            }
        }
        accesses
    }

    // -- helpers ------------------------------------------------------------------

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

    fn is_declared_exported(&self, symbol: SymbolId) -> bool {
        let decl = self.scoping.symbol_declaration(symbol);
        let p1 = self.parent(decl);
        let p2 = p1.and_then(|p| self.parent(p));
        [p1, p2].into_iter().flatten().any(|p| {
            matches!(
                self.kind(p),
                AstKind::ExportDeclaration(_)
                    | AstKind::ExportNamedDeclaration(_)
                    | AstKind::ExportDefaultDeclaration(_)
            )
        })
    }

    fn is_exported(&self, symbol: SymbolId) -> bool {
        self.is_declared_exported(symbol)
            || self.scoping.get_resolved_reference_ids(symbol).iter().any(|id| {
                let node = self.scoping.get_reference(*id).node_id();
                self.parent(node).is_some_and(|p| matches!(self.kind(p), AstKind::ExportSpecifier(_)))
            })
    }

    fn describe_escape(&self, parent: NodeId, r: oxc_span::Span) -> String {
        match self.kind(parent) {
            AstKind::CallExpression(_) | AstKind::NewExpression(_) => "passed as an argument".into(),
            AstKind::ReturnStatement(_) | AstKind::ArrowFunctionExpression(_) => "returned".into(),
            AstKind::ExportSpecifier(_) | AstKind::ExportDefaultDeclaration(_) => "exported".into(),
            AstKind::SpreadElement(_) => "spread".into(),
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

    fn diagnose(
        &mut self,
        code: &'static str,
        severity: &'static str,
        message: String,
        span: ir::Span,
        related: Vec<String>,
    ) {
        self.diagnostics.push(ir::Diagnostic { kind: "Diagnostic", code, severity, message, span, related });
    }
}

enum PropertyKeyOwned {
    Name(String),
    Dynamic,
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
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
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

fn infer_annotation(member_kind: &str, value_kind: &str) -> Annotation {
    if member_kind == "getter" {
        return Annotation::Computed { modifier: "default" };
    }
    if value_kind == "generator" {
        return Annotation::Flow { bound: false };
    }
    if member_kind == "method" || value_kind == "function" {
        return Annotation::AutoAction { bound: false };
    }
    Annotation::Observable { modifier: "deep" }
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
