/**
 * SPIKE: a slice of the analyzer ported to TS-ESTree + @typescript-eslint/scope-manager.
 *
 * Accepts a TS-ESTree `Program` from either `@typescript-eslint/typescript-estree` or
 * `oxc-parser` (with `range: true`, `preserveParens: false`). Covers imports, `observable()`
 * objects, property accesses, `reaction` / `autorun`, and their diagnostics. Not exported.
 */
import {
	analyze as analyzeScopes,
	type Reference,
	type Variable,
} from "@typescript-eslint/scope-manager";
import { AST_NODE_TYPES as N, type TSESTree } from "@typescript-eslint/types";
import { visitorKeys } from "@typescript-eslint/visitor-keys";
import {
	type Access,
	type AccessContext,
	type AccessKey,
	type Annotation,
	type Binding,
	type Diagnostic,
	type DiagnosticCode,
	type FunctionRef,
	IR_VERSION,
	type KnownApi,
	type ObjectObservable,
	type ObservableId,
	type ObservableMember,
	type ObservableShape,
	type Options,
	type OptionValue,
	type Reaction,
	type ReactionId,
	type SobxImport,
	type SobxModule,
	type Span,
	type UnmodeledApi,
	type UnsupportedUsage,
	type ValueKind,
} from "../types.js";

type Node = TSESTree.Node;
type Fn =
	| TSESTree.ArrowFunctionExpression
	| TSESTree.FunctionExpression
	| TSESTree.FunctionDeclaration;
type PendingAccess = Access extends infer A
	? A extends Access
		? Omit<A, "id">
		: never
	: never;
type FunctionRole =
	| { kind: "tracked"; by: ReactionId }
	| { kind: "effect"; reaction: ReactionId };

const MODELED: ReadonlySet<string> = new Set([
	"action",
	"autorun",
	"computed",
	"makeAutoObservable",
	"makeObservable",
	"observable",
	"reaction",
	"runInAction",
]);
const UNMODELED: ReadonlySet<string> = new Set(["flow", "when"]);
const ANNOTATING: ReadonlySet<string> = new Set([
	"observable",
	"makeObservable",
	"makeAutoObservable",
]);
const OBJECT_ENUMERATORS: ReadonlySet<string> = new Set([
	"keys",
	"values",
	"entries",
	"assign",
	"getOwnPropertyNames",
	"freeze",
]);
const MUTATING_ARRAY_METHODS: ReadonlySet<string> = new Set([
	"copyWithin",
	"fill",
	"pop",
	"push",
	"reverse",
	"shift",
	"sort",
	"splice",
	"unshift",
]);
const TYPE_CONTEXTS: ReadonlySet<string> = new Set([
	N.TSTypeAnnotation,
	N.TSTypeQuery,
	N.TSTypeReference,
	N.TSTypeAliasDeclaration,
	N.TSInterfaceDeclaration,
	N.TSTypeParameterInstantiation,
	N.TSTypeLiteral,
	N.TSIndexedAccessType,
	N.TSImportType,
]);

export interface EstreeAnalyzeOptions {
	moduleSpecifier?: string;
	filename?: string;
}

/** SPIKE entry point. `source` is used for line/column computation. */
export function analyzeEstree(
	program: TSESTree.Program,
	source: string,
	options: EstreeAnalyzeOptions = {},
): SobxModule {
	return new EstreeAnalyzer(program, source, options).run();
}

class EstreeAnalyzer {
	private readonly moduleSpecifier: string;
	private readonly filename: string | null;
	private readonly parents = new Map<Node, Node>();
	private readonly lineStarts: number[];
	private readonly refByIdentifier = new Map<Node, Reference>();
	private readonly scopes: ReturnType<typeof analyzeScopes>;

	private readonly imports: SobxImport[] = [];
	private readonly observables: ObjectObservable[] = [];
	private readonly reactions: Reaction[] = [];
	private readonly unsupported: UnsupportedUsage[] = [];
	private readonly diagnostics: Diagnostic[] = [];
	private readonly pending: PendingAccess[] = [];

	private readonly apiRefs = new Map<Node, KnownApi>();
	private readonly calls = new Map<KnownApi, TSESTree.CallExpression[]>();
	private readonly functionRoles = new Map<Node, FunctionRole>();
	private readonly observableVars = new Map<Variable, ObservableId>();
	private readonly reported = new Set<Node>();

	constructor(
		private readonly program: TSESTree.Program,
		source: string,
		options: EstreeAnalyzeOptions,
	) {
		this.moduleSpecifier = options.moduleSpecifier ?? "sobx";
		this.filename = options.filename ?? null;
		this.lineStarts = lineStarts(source);
		indexParents(program, this.parents);
		this.scopes = analyzeScopes(program, { sourceType: "module" });
		for (const scope of this.scopes.scopes) {
			for (const ref of scope.references) {
				this.refByIdentifier.set(ref.identifier, ref);
			}
		}
	}

	run(): SobxModule {
		this.collectImports();
		for (const call of this.sorted("observable"))
			this.visitObservableCall(call);
		for (const call of this.sorted("reaction", "autorun")) {
			this.visitReactionCall(call);
		}
		for (const [variable, id] of this.observableVars) {
			for (const ref of this.valueRefs(variable)) {
				this.classifyReference(ref.identifier, id, variable.name);
			}
		}
		const accesses = this.finalize();
		this.diagnostics.sort(
			(a, b) =>
				a.span.start - b.span.start ||
				a.span.end - b.span.end ||
				a.code.localeCompare(b.code),
		);
		return {
			kind: "Module",
			irVersion: IR_VERSION,
			filename: this.filename,
			moduleSpecifier: this.moduleSpecifier,
			imports: this.imports,
			observables: this.observables,
			computeds: [],
			accesses,
			reactions: this.reactions,
			actions: [],
			unsupported: this.unsupported,
			diagnostics: this.diagnostics,
		};
	}

	// -- imports ----------------------------------------------------------------

	private collectImports(): void {
		const refs: Array<{ node: Node; api: KnownApi | null; local: string }> = [];
		for (const stmt of this.program.body) {
			if (stmt.type !== N.ImportDeclaration) continue;
			if (stmt.source.value !== this.moduleSpecifier) continue;
			if (stmt.importKind === "type") continue;
			for (const spec of stmt.specifiers) {
				const local = spec.local.name;
				const span = this.span(spec);
				if (spec.type === N.ImportNamespaceSpecifier) {
					this.imports.push({ kind: "NamespaceImport", local, span });
					this.diagnose(
						"namespace-import",
						"error",
						`Namespace import "${local}" from "${this.moduleSpecifier}" is not analyzed; use named imports.`,
						span,
					);
					continue;
				}
				if (spec.type === N.ImportDefaultSpecifier) {
					this.imports.push({ kind: "DefaultImport", local, span });
					this.diagnose(
						"default-import",
						"error",
						`Default import "${local}" from "${this.moduleSpecifier}" is not analyzed; use named imports.`,
						span,
					);
					continue;
				}
				if (spec.importKind === "type") continue;
				const imported =
					spec.imported.type === N.Identifier
						? spec.imported.name
						: String(spec.imported.value);
				const api =
					MODELED.has(imported) || UNMODELED.has(imported)
						? (imported as KnownApi)
						: null;
				this.imports.push({ kind: "NamedImport", imported, local, api, span });
				if (api === null) {
					this.diagnose(
						"unknown-import",
						"warning",
						`"${imported}" is not a known export of "${this.moduleSpecifier}".`,
						span,
					);
				}
				const variable = this.scopes.getDeclaredVariables(spec)[0];
				if (!variable) continue;
				for (const ref of this.valueRefs(variable)) {
					if (api !== null) this.apiRefs.set(ref.identifier, api);
					refs.push({ node: ref.identifier, api, local });
				}
			}
		}
		refs.sort((a, b) => a.node.range[0] - b.node.range[0]);
		for (const { node, api, local } of refs) {
			this.classifyApiReference(node, api, local);
		}
	}

	private classifyApiReference(
		ref: Node,
		api: KnownApi | null,
		local: string,
	): void {
		let expr: Node = ref;
		let memberName: string | null = null;
		const parent = this.parent(ref);
		if (
			parent?.type === N.MemberExpression &&
			parent.object === ref &&
			!parent.computed &&
			parent.property.type === N.Identifier
		) {
			memberName = parent.property.name;
			expr = parent;
		}
		const exprParent = this.parent(expr);
		const call =
			exprParent?.type === N.CallExpression && exprParent.callee === expr
				? exprParent
				: null;
		const span = this.span(ref);

		if (api === null || UNMODELED.has(api)) {
			this.unsupported.push({
				kind: "UnsupportedUsage",
				api: api as UnmodeledApi | null,
				local,
				span,
			});
			if (api !== null) {
				this.diagnose(
					"unsupported-api",
					"error",
					`"${api}" is not supported by sobx yet.`,
					span,
				);
			}
			return;
		}
		if (this.isAnnotationPosition(call ?? expr)) return;
		if (memberName !== null) {
			this.diagnose(
				"unsupported-api",
				"error",
				`"${local}.${memberName}" is not supported by sobx yet.`,
				this.span(expr),
			);
			return;
		}
		if (!call) {
			this.diagnose(
				"api-not-called",
				"error",
				`"${local}" must be called directly or used as an annotation; other uses cannot be analyzed.`,
				span,
			);
			return;
		}
		const list = this.calls.get(api) ?? [];
		list.push(call);
		this.calls.set(api, list);
	}

	private isAnnotationPosition(node: Node): boolean {
		const parent = this.parent(node);
		if (parent?.type === N.Decorator) return true;
		if (parent?.type !== N.Property || parent.value !== node) return false;
		const object = this.parent(parent);
		const call = object && this.parent(object);
		if (call?.type !== N.CallExpression || call.arguments[1] !== object) {
			return false;
		}
		const api = this.apiRefs.get(call.callee);
		return api !== undefined && ANNOTATING.has(api);
	}

	private sorted(...apis: KnownApi[]): TSESTree.CallExpression[] {
		return apis
			.flatMap((api) => this.calls.get(api) ?? [])
			.sort((a, b) => a.range[0] - b.range[0]);
	}

	// -- observable() -------------------------------------------------------------

	private visitObservableCall(call: TSESTree.CallExpression): void {
		const id: ObservableId = `observable:${this.observables.length}`;
		const span = this.span(call);
		const [arg] = call.arguments;
		if (!arg || arg.type === N.SpreadElement) {
			this.diagnose(
				"invalid-arguments",
				"error",
				"observable() expects an initial value as its first argument.",
				span,
			);
		}
		const shape: ObservableShape =
			arg?.type === N.ObjectExpression
				? this.objectShape(arg, id)
				: { kind: "unknown" };

		const outer = this.outer(call);
		const resolved = this.resolveResultBinding(outer);
		if (resolved) {
			this.registerObservable(resolved, outer, id);
			if (isDeclaredExported(resolved.variable, this.parents)) {
				this.diagnose(
					"observable-escape",
					"error",
					`Observable "${resolved.binding.name}" is exported; accesses in other modules are not tracked.`,
					this.span(resolved.variable.identifiers[0] as Node),
					[id],
				);
			}
		} else {
			this.diagnose(
				"unbound-observable",
				"error",
				"observable() result must be stored in a variable to be analyzed.",
				span,
				[id],
			);
		}
		this.observables.push({
			kind: "Observable",
			id,
			source: "observable",
			target: "object",
			binding: resolved?.binding ?? null,
			shape,
			options: call.arguments[2] ? this.options(call.arguments[2]) : null,
			span,
		});
	}

	private objectShape(
		object: TSESTree.ObjectExpression,
		observable: ObservableId,
	): ObservableShape {
		const members: ObservableMember[] = [];
		let open = false;
		for (const prop of object.properties) {
			if (prop.type === N.SpreadElement) {
				open = true;
				continue;
			}
			const key = propertyKey(prop.key, prop.computed);
			if (key.kind === "dynamic") {
				open = true;
				continue;
			}
			if (prop.kind === "set") continue;
			const value = prop.value;
			const memberKind: ObservableMember["memberKind"] =
				prop.kind === "get" ? "getter" : prop.method ? "method" : "field";
			const kind: ValueKind =
				memberKind === "getter"
					? "getter"
					: memberKind === "method"
						? (value as TSESTree.FunctionExpression).generator
							? "generator"
							: "function"
						: valueKind(value);
			members.push({
				key: key.name,
				memberKind,
				valueKind: kind,
				static: false,
				accessor: false,
				annotation: inferAnnotation(memberKind, kind),
				annotationSource: "inferred",
				computed: null,
				action: null,
				span: this.span(prop),
			});
			if (kind === "generator") {
				this.diagnose(
					"unsupported-api",
					"error",
					`"${key.name}" is a generator and would be inferred as a flow, which is not supported by sobx yet.`,
					this.span(prop),
					[observable],
				);
			}
		}
		return { kind: "object", members, open };
	}

	private resolveResultBinding(
		outer: Node,
	): { binding: Binding; variable: Variable } | null {
		const parent = this.parent(outer);
		let name: string | null = null;
		let kind: Binding["declarationKind"] = "const";
		let variable: Variable | null = null;

		if (
			parent?.type === N.VariableDeclarator &&
			parent.init === outer &&
			parent.id.type === N.Identifier
		) {
			const decl = this.parent(parent);
			kind =
				decl?.type === N.VariableDeclaration &&
				(decl.kind === "let" || decl.kind === "var")
					? decl.kind
					: "const";
			name = parent.id.name;
			variable =
				this.scopes.getDeclaredVariables(parent).find((v) => v.name === name) ??
				null;
		} else if (
			parent?.type === N.AssignmentExpression &&
			parent.operator === "=" &&
			parent.right === outer &&
			parent.left.type === N.Identifier
		) {
			kind = "assignment";
			name = parent.left.name;
			variable = this.refByIdentifier.get(parent.left)?.resolved ?? null;
		}
		if (!name || !variable) return null;
		return {
			variable,
			binding: {
				name,
				scope:
					variable.scope.type === "module" || variable.scope.type === "global"
						? "module"
						: "local",
				declarationKind: kind,
				exported: isExported(variable, this.parents),
			},
		};
	}

	private registerObservable(
		resolved: { binding: Binding; variable: Variable },
		outer: Node,
		id: ObservableId,
	): void {
		const parent = this.parent(outer);
		const assignment = parent?.type === N.AssignmentExpression ? parent : null;
		if (this.observableVars.has(resolved.variable)) {
			if (assignment && this.reported.has(assignment)) return;
			if (assignment) this.reported.add(assignment);
			this.diagnose(
				"observable-reassigned",
				"error",
				`"${resolved.binding.name}" is assigned more than one observable.`,
				this.span(assignment ?? outer),
				[id],
			);
			return;
		}
		this.observableVars.set(resolved.variable, id);
		for (const ref of resolved.variable.references) {
			if (!ref.isWrite() || ref.init) continue;
			const violation = this.parent(ref.identifier) ?? ref.identifier;
			if (violation === assignment) continue;
			if (this.reported.has(violation)) continue;
			this.reported.add(violation);
			this.diagnose(
				"observable-reassigned",
				"error",
				`"${resolved.variable.name}" is reassigned; references may not point at the observable.`,
				this.span(violation),
				[id],
			);
		}
	}

	// -- reaction() / autorun() ---------------------------------------------------

	private visitReactionCall(call: TSESTree.CallExpression): void {
		const api = this.apiRefs.get(call.callee) as "reaction" | "autorun";
		const span = this.span(call);
		const id: ReactionId = `reaction:${this.reactions.length}`;
		const disposerUsed =
			this.parent(this.outer(call))?.type !== N.ExpressionStatement;
		const args = call.arguments;

		if (api === "autorun") {
			const [body, opts] = args;
			if (!body || body.type === N.SpreadElement) {
				this.diagnose(
					"invalid-arguments",
					"error",
					"autorun() expects a function.",
					span,
				);
				return;
			}
			const fn = this.functionRef(body, { kind: "tracked", by: id });
			if (fn.kind === "opaque") this.opaque("autorun() body", fn, id);
			this.reactions.push({
				kind: "Reaction",
				id,
				api,
				body: fn,
				options: opts ? this.options(opts) : null,
				dependencies: [],
				indirectDependencies: [],
				disposerUsed,
				span,
			});
			return;
		}

		const [data, effect, opts] = args;
		if (
			!data ||
			!effect ||
			data.type === N.SpreadElement ||
			effect.type === N.SpreadElement
		) {
			this.diagnose(
				"invalid-arguments",
				"error",
				"reaction() expects a data function and an effect function.",
				span,
			);
			return;
		}
		const dataRef = this.functionRef(data, { kind: "tracked", by: id });
		const effectRef = this.functionRef(effect, {
			kind: "effect",
			reaction: id,
		});
		if (dataRef.kind === "opaque") {
			this.opaque("reaction() data function", dataRef, id);
		}
		this.reactions.push({
			kind: "Reaction",
			id,
			api,
			data: dataRef,
			effect: effectRef,
			options: opts ? this.options(opts) : null,
			dependencies: [],
			indirectDependencies: [],
			disposerUsed,
			span,
		});
	}

	private opaque(what: string, fn: FunctionRef, id: ReactionId): void {
		this.diagnose(
			"opaque-function",
			"error",
			`${what} must be an inline function so its dependencies can be analyzed.`,
			fn.span,
			[id],
		);
	}

	private functionRef(node: Node, role: FunctionRole): FunctionRef {
		if (
			node.type === N.ArrowFunctionExpression ||
			node.type === N.FunctionExpression
		) {
			this.functionRoles.set(node, role);
			return {
				kind: "inline",
				params: node.params.length,
				async: node.async,
				span: this.span(node),
			};
		}
		return { kind: "opaque", span: this.span(node) };
	}

	private options(node: Node): Options {
		if (node.type !== N.ObjectExpression) {
			return { kind: "unknown", span: this.span(node) };
		}
		const entries: Record<string, OptionValue> = {};
		let open = false;
		for (const prop of node.properties) {
			if (prop.type === N.SpreadElement) {
				open = true;
				continue;
			}
			const key = propertyKey(prop.key, prop.computed);
			if (key.kind === "dynamic") {
				open = true;
				continue;
			}
			entries[key.name] = prop.method
				? { kind: "unknown" }
				: optionValue(prop.value);
		}
		return { kind: "object", entries, open };
	}

	// -- references ---------------------------------------------------------------

	private classifyReference(ref: Node, id: ObservableId, name: string): void {
		const r = this.outer(ref);
		const parent = this.parent(r);
		if (!parent) return;
		const context = this.contextOf(ref);

		if (parent.type === N.MemberExpression && parent.object === r) {
			const key = memberKey(parent);
			this.checkDynamicKey(key, context, parent, id);
			this.pending.push(this.memberAccess(parent, id, key, context));
			this.checkDeepMutation(parent, id, key, context);
			return;
		}

		const pattern =
			parent.type === N.VariableDeclarator &&
			parent.init === r &&
			parent.id.type === N.ObjectPattern
				? parent.id
				: parent.type === N.AssignmentExpression &&
						parent.right === r &&
						parent.left.type === N.ObjectPattern
					? parent.left
					: null;
		if (pattern) {
			for (const prop of pattern.properties) {
				if (prop.type === N.RestElement) {
					this.diagnose(
						"observable-escape",
						"error",
						`Rest element copies every property of observable "${name}"; this is not tracked.`,
						this.span(prop),
						[id],
					);
					continue;
				}
				const key = propertyKey(prop.key, prop.computed);
				this.checkDynamicKey(key, context, prop, id);
				this.pending.push({
					kind: "Read",
					via: "destructure",
					path: [],
					called: false,
					observable: id,
					key,
					receiver: "binding",
					context,
					span: this.span(prop),
				});
			}
			return;
		}

		if (
			parent.type === N.ExpressionStatement ||
			(parent.type === N.UnaryExpression &&
				(parent.operator === "typeof" || parent.operator === "void")) ||
			(parent.type === N.BinaryExpression &&
				["===", "!==", "==", "!="].includes(parent.operator))
		) {
			return;
		}
		if (
			parent.type === N.BinaryExpression &&
			parent.operator === "in" &&
			parent.right === r
		) {
			this.diagnose(
				"unsupported-operation",
				"error",
				`The "in" operator on observable "${name}" is not supported.`,
				this.span(parent),
				[id],
			);
			return;
		}
		if (parent.type === N.ForInStatement && parent.right === r) {
			this.diagnose(
				"unsupported-operation",
				"error",
				`Enumerating observable "${name}" with for...in is not supported.`,
				this.span(r),
				[id],
			);
			return;
		}
		if (
			parent.type === N.CallExpression &&
			parent.arguments.includes(r as TSESTree.CallExpressionArgument)
		) {
			const callee = parent.callee;
			if (
				callee.type === N.MemberExpression &&
				callee.object.type === N.Identifier &&
				callee.object.name === "Object" &&
				callee.property.type === N.Identifier &&
				OBJECT_ENUMERATORS.has(callee.property.name) &&
				!this.isLocallyBound(callee.object)
			) {
				this.diagnose(
					"unsupported-operation",
					"error",
					`Object.${callee.property.name}() on observable "${name}" is not supported.`,
					this.span(parent),
					[id],
				);
				return;
			}
		}
		this.diagnose(
			"observable-escape",
			"error",
			`Observable "${name}" escapes analysis (${describeEscape(parent, r)}); accesses through other references are not tracked.`,
			this.span(r),
			[id],
		);
	}

	private memberAccess(
		member: TSESTree.MemberExpression,
		observable: ObservableId,
		key: AccessKey,
		context: AccessContext,
	): PendingAccess {
		const m = this.outer(member);
		const parent = this.parent(m);
		const base = {
			observable,
			key,
			receiver: "binding" as const,
			context,
			span: this.span(member),
		};
		if (parent?.type === N.AssignmentExpression && parent.left === m) {
			return {
				kind: "Write",
				...base,
				operator: parent.operator,
				readsPrevious: parent.operator !== "=",
			};
		}
		if (parent?.type === N.UpdateExpression) {
			return {
				kind: "Write",
				...base,
				operator: parent.operator,
				readsPrevious: true,
			};
		}
		if (parent?.type === N.UnaryExpression && parent.operator === "delete") {
			return { kind: "Delete", ...base };
		}
		if (
			((parent?.type === N.ForInStatement ||
				parent?.type === N.ForOfStatement) &&
				parent.left === m) ||
			parent?.type === N.ArrayPattern ||
			parent?.type === N.RestElement ||
			(parent?.type === N.AssignmentPattern && parent.left === m) ||
			(parent?.type === N.Property &&
				parent.value === m &&
				this.parent(parent)?.type === N.ObjectPattern)
		) {
			return { kind: "Write", ...base, operator: "=", readsPrevious: false };
		}
		return {
			kind: "Read",
			...base,
			via: "member",
			path: this.readPath(m),
			called: parent?.type === N.CallExpression && parent.callee === m,
		};
	}

	private readPath(member: Node): AccessKey[] {
		const path: AccessKey[] = [];
		let current = member;
		for (;;) {
			const parent = this.parent(current);
			if (parent?.type !== N.MemberExpression || parent.object !== current) {
				break;
			}
			const key = memberKey(parent);
			path.push(key);
			if (key.kind === "dynamic") break;
			current = this.outer(parent);
		}
		return path;
	}

	private checkDeepMutation(
		member: TSESTree.MemberExpression,
		observable: ObservableId,
		key: AccessKey,
		context: AccessContext,
	): void {
		const first = this.outer(member);
		let top = first;
		for (;;) {
			const parent = this.parent(top);
			if (parent?.type !== N.MemberExpression || parent.object !== top) break;
			top = this.outer(parent);
		}
		if (top === first || top.type !== N.MemberExpression) return;
		const name = key.kind === "static" ? key.name : "<dynamic>";
		if (this.memberAccess(top, observable, key, context).kind !== "Read") {
			this.diagnose(
				"deep-mutation",
				"warning",
				`Mutation of a value nested in observable property "${name}" is not tracked.`,
				this.span(top),
				[observable],
			);
			return;
		}
		const call = this.parent(top);
		if (call?.type !== N.CallExpression || call.callee !== top) return;
		const kind = this.propertyValueKind(observable, key);
		const method = memberKey(top);
		const mutates =
			kind === "object" ||
			(kind === "array" &&
				(method.kind === "dynamic" || MUTATING_ARRAY_METHODS.has(method.name)));
		if (mutates) {
			this.diagnose(
				"deep-mutation",
				"warning",
				`Method call on ${kind} nested in observable property "${name}" may mutate it; this is not tracked.`,
				this.span(call),
				[observable],
			);
		}
	}

	private propertyValueKind(
		observable: ObservableId,
		key: AccessKey,
	): ValueKind | null {
		if (key.kind !== "static") return null;
		const shape = this.observables.find((o) => o.id === observable)?.shape;
		if (shape?.kind !== "object") return null;
		return shape.members.find((m) => m.key === key.name)?.valueKind ?? null;
	}

	private checkDynamicKey(
		key: AccessKey,
		context: AccessContext,
		node: Node,
		observable: ObservableId,
	): void {
		if (key.kind !== "dynamic") return;
		const tracked = context.kind === "tracked";
		this.diagnose(
			"dynamic-key",
			tracked ? "error" : "warning",
			tracked
				? "Dynamic property key inside a tracked function; the dependency cannot be determined statically."
				: "Dynamic property key on an observable.",
			this.span(node),
			[observable],
		);
	}

	private contextOf(node: Node): AccessContext {
		let crossed = false;
		for (let p = this.parent(node); p; p = this.parent(p)) {
			const role = this.functionRoles.get(p);
			if (role) {
				if (!crossed) return role;
				if (role.kind === "tracked") {
					return { kind: "tracked-nested", by: role.by };
				}
				return role;
			}
			if (isFunction(p)) crossed = true;
		}
		return { kind: "untracked" };
	}

	private finalize(): Access[] {
		this.pending.sort(
			(a, b) => a.span.start - b.span.start || a.span.end - b.span.end,
		);
		const accesses = this.pending.map(
			(a, i) => ({ ...a, id: `access:${i}` }) as Access,
		);
		const reactions = new Map(this.reactions.map((r) => [r.id, r]));
		for (const access of accesses) {
			const ctx = access.context;
			const target =
				access.kind === "ComputedRead" ? access.computed : access.observable;
			const isRead = access.kind === "Read" || access.kind === "ComputedRead";
			if (ctx.kind === "tracked") {
				const reaction = reactions.get(ctx.by as ReactionId);
				if (isRead) reaction?.dependencies.push(access.id);
				else {
					this.diagnose(
						"write-in-derivation",
						"warning",
						"Observable write inside a tracked function (computed / reaction data / autorun).",
						access.span,
						[target, ctx.by, access.id],
					);
				}
			} else if (ctx.kind === "tracked-nested") {
				this.diagnose(
					"untracked-nested-read",
					"warning",
					"Observable access inside a function nested in a tracked function; it is only tracked if the function runs during tracking.",
					access.span,
					[target, ctx.by, access.id],
				);
			}
		}
		return accesses;
	}

	// -- helpers ------------------------------------------------------------------

	private parent(node: Node): Node | undefined {
		return this.parents.get(node);
	}

	/** Walk up through value-preserving wrappers (`as`, `!`, `satisfies`, `?.` chains). */
	private outer(node: Node): Node {
		let n = node;
		for (;;) {
			const p = this.parent(n);
			if (
				p &&
				(p.type === N.TSAsExpression ||
					p.type === N.TSSatisfiesExpression ||
					p.type === N.TSNonNullExpression ||
					p.type === N.TSTypeAssertion ||
					p.type === N.ChainExpression) &&
				p.expression === n
			) {
				n = p;
				continue;
			}
			return n;
		}
	}

	private isInTypePosition(node: Node): boolean {
		for (let p = this.parent(node); p; p = this.parent(p)) {
			if (TYPE_CONTEXTS.has(p.type)) return true;
			if (p.type.endsWith("Statement") || p.type.endsWith("Declaration")) {
				return false;
			}
		}
		return false;
	}

	private valueRefs(variable: Variable): Reference[] {
		// Pure writes (`s = x`) are reassignments, not uses; Babel keeps them apart too.
		return variable.references
			.filter(
				(r) =>
					!r.init &&
					!(r.isWrite() && !r.isRead()) &&
					!this.isInTypePosition(r.identifier),
			)
			.sort((a, b) => a.identifier.range[0] - b.identifier.range[0]);
	}

	private isLocallyBound(identifier: TSESTree.Identifier): boolean {
		const ref = this.refByIdentifier.get(identifier);
		return (ref?.resolved?.defs.length ?? 0) > 0;
	}

	private span(node: Node): Span {
		const [start, end] = node.range;
		return {
			start,
			end,
			loc: { start: this.position(start), end: this.position(end) },
		};
	}

	private position(offset: number): { line: number; column: number } {
		let lo = 0;
		let hi = this.lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
			else hi = mid - 1;
		}
		return { line: lo + 1, column: offset - (this.lineStarts[lo] ?? 0) };
	}

	private diagnose(
		code: DiagnosticCode,
		severity: Diagnostic["severity"],
		message: string,
		span: Span,
		related?: Diagnostic["related"],
	): void {
		const d: Diagnostic = { kind: "Diagnostic", code, severity, message, span };
		if (related && related.length > 0) d.related = related;
		this.diagnostics.push(d);
	}
}

// ---------------------------------------------------------------------------

function indexParents(root: Node, parents: Map<Node, Node>): void {
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const node = stack.pop() as Node;
		const keys =
			(visitorKeys as Record<string, readonly string[] | undefined>)[
				node.type
			] ?? Object.keys(node);
		for (const key of keys) {
			if (key === "parent") continue;
			const child = (node as unknown as Record<string, unknown>)[key];
			const children = Array.isArray(child) ? child : [child];
			for (const c of children) {
				if (
					c &&
					typeof c === "object" &&
					typeof (c as Node).type === "string"
				) {
					parents.set(c as Node, node);
					stack.push(c as Node);
				}
			}
		}
	}
}

function lineStarts(source: string): number[] {
	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		const ch = source.charCodeAt(i);
		if (ch === 10) starts.push(i + 1);
		else if (ch === 13) {
			if (source.charCodeAt(i + 1) === 10) i++;
			starts.push(i + 1);
		}
	}
	return starts;
}

function isFunction(node: Node): node is Fn {
	return (
		node.type === N.ArrowFunctionExpression ||
		node.type === N.FunctionExpression ||
		node.type === N.FunctionDeclaration
	);
}

function declarationOf(variable: Variable): Node | undefined {
	return variable.defs[0]?.node as Node | undefined;
}

function isDeclaredExported(
	variable: Variable,
	parents: Map<Node, Node>,
): boolean {
	const decl = declarationOf(variable);
	if (!decl) return false;
	const p1 = parents.get(decl);
	const p2 = p1 && parents.get(p1);
	return (
		p1?.type === N.ExportNamedDeclaration ||
		p1?.type === N.ExportDefaultDeclaration ||
		p2?.type === N.ExportNamedDeclaration ||
		p2?.type === N.ExportDefaultDeclaration
	);
}

function isExported(variable: Variable, parents: Map<Node, Node>): boolean {
	if (isDeclaredExported(variable, parents)) return true;
	return variable.references.some(
		(r) => parents.get(r.identifier)?.type === N.ExportSpecifier,
	);
}

function propertyKey(key: Node, computed: boolean): AccessKey {
	if (!computed && key.type === N.Identifier) {
		return { kind: "static", name: key.name };
	}
	if (key.type === N.Literal) {
		if (typeof key.value === "string")
			return { kind: "static", name: key.value };
		if (typeof key.value === "number") {
			return { kind: "static", name: String(key.value) };
		}
	}
	if (
		key.type === N.TemplateLiteral &&
		key.expressions.length === 0 &&
		key.quasis.length === 1
	) {
		return { kind: "static", name: key.quasis[0]?.value.cooked ?? "" };
	}
	return { kind: "dynamic" };
}

function memberKey(node: TSESTree.MemberExpression): AccessKey {
	if (node.property.type === N.PrivateIdentifier) return { kind: "dynamic" };
	return propertyKey(node.property, node.computed);
}

function valueKind(node: Node): ValueKind {
	if (node.type === N.Literal) {
		if ("regex" in node && node.regex) return "unknown";
		return "primitive";
	}
	if (
		(node.type === N.TemplateLiteral && node.expressions.length === 0) ||
		(node.type === N.Identifier && node.name === "undefined") ||
		(node.type === N.UnaryExpression &&
			node.argument.type === N.Literal &&
			typeof node.argument.value === "number")
	) {
		return "primitive";
	}
	if (node.type === N.ObjectExpression) return "object";
	if (node.type === N.ArrayExpression) return "array";
	if (node.type === N.FunctionExpression && node.generator) return "generator";
	if (
		node.type === N.ArrowFunctionExpression ||
		node.type === N.FunctionExpression
	) {
		return "function";
	}
	if (
		node.type === N.TSAsExpression ||
		node.type === N.TSSatisfiesExpression ||
		node.type === N.TSNonNullExpression ||
		node.type === N.TSTypeAssertion
	) {
		return valueKind(node.expression);
	}
	return "unknown";
}

function inferAnnotation(
	memberKind: ObservableMember["memberKind"],
	kind: ValueKind,
): Annotation {
	if (memberKind === "getter") return { kind: "computed", modifier: "default" };
	if (kind === "generator") return { kind: "flow", bound: false };
	if (memberKind === "method" || kind === "function") {
		return { kind: "autoAction", bound: false };
	}
	return { kind: "observable", modifier: "deep" };
}

function optionValue(node: Node): OptionValue {
	if (node.type === N.Literal && !("regex" in node && node.regex)) {
		const v = node.value;
		if (
			v === null ||
			typeof v === "string" ||
			typeof v === "number" ||
			typeof v === "boolean"
		) {
			return { kind: "literal", value: v };
		}
	}
	return { kind: "unknown" };
}

function describeEscape(parent: Node, ref: Node): string {
	switch (parent.type) {
		case N.CallExpression:
		case N.NewExpression:
			return "passed as an argument";
		case N.ReturnStatement:
		case N.ArrowFunctionExpression:
			return "returned";
		case N.ExportSpecifier:
		case N.ExportDefaultDeclaration:
			return "exported";
		case N.SpreadElement:
			return "spread";
		case N.VariableDeclarator:
		case N.AssignmentExpression:
			return "aliased";
		case N.ArrayExpression:
		case N.Property:
			return "stored in another value";
		case N.ForOfStatement:
			return parent.right === ref ? "iterated" : `used in ${parent.type}`;
		default:
			return `used in ${parent.type}`;
	}
}
