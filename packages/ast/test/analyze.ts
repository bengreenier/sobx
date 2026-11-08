import { parse } from "@babel/parser";
import type { Binding as BabelBinding, NodePath } from "@babel/traverse";
import babelTraverse from "@babel/traverse";
import * as t from "@babel/types";
import {
	type Access,
	type AccessContext,
	type AccessId,
	type AccessKey,
	type Action,
	type ActionId,
	type ActionSource,
	type Annotation,
	type Binding,
	type ClassObservable,
	type Computed,
	type ComputedId,
	type DerivationId,
	type Diagnostic,
	type DiagnosticCode,
	type FunctionRef,
	IR_VERSION,
	type KnownApi,
	type ModeledApi,
	type ObjectObservable,
	type Observable,
	type ObservableId,
	type ObservableMember,
	type ObservableShape,
	type ObservableSource,
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
} from "../src/types.js";

/**
 * `@babel/traverse` is ESM; when this package is consumed as CJS, bundler interop can hand us
 * the module namespace instead of the default-exported function.
 */
const traverse: typeof babelTraverse =
	typeof babelTraverse === "function"
		? babelTraverse
		: (babelTraverse as unknown as { default: typeof babelTraverse }).default;

/** Default module specifier treated as the MobX-compatible API. */
export const DEFAULT_MODULE_SPECIFIER = "@sobx/magic";

export interface AnalyzeOptions {
	/** Module specifier whose imports are analyzed. Default `"@sobx/magic"`. */
	moduleSpecifier?: string;
	/** Filename recorded in the resulting {@link SobxModule}. */
	filename?: string;
}

const MODELED_APIS: ReadonlySet<string> = new Set<ModeledApi>([
	"action",
	"autorun",
	"computed",
	"makeAutoObservable",
	"makeObservable",
	"observable",
	"reaction",
	"runInAction",
]);

const UNMODELED_APIS: ReadonlySet<string> = new Set<UnmodeledApi>([
	"flow",
	"when",
]);

/** APIs whose second argument is an annotations / overrides object. */
const ANNOTATING_APIS: ReadonlySet<KnownApi> = new Set<KnownApi>([
	"observable",
	"makeObservable",
	"makeAutoObservable",
]);

/** Array methods that mutate in place. Other array methods are treated as reads. */
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

/** `Object.*` helpers that enumerate or copy an object's properties. */
const OBJECT_ENUMERATORS: ReadonlySet<string> = new Set([
	"keys",
	"values",
	"entries",
	"assign",
	"getOwnPropertyNames",
	"freeze",
]);

/**
 * Parse `source` and build the sobx IR for it.
 *
 * @param source - TypeScript / JavaScript module source (JSX and decorators allowed).
 */
export function analyze(
	source: string,
	options: AnalyzeOptions = {},
): SobxModule {
	const file = parse(source, {
		sourceType: "module",
		plugins: ["typescript", "jsx", "decorators", "decoratorAutoAccessors"],
	});
	return analyzeAst(file, options);
}

/**
 * Build the sobx IR from an already-parsed Babel `File`. The AST is not mutated.
 */
export function analyzeAst(
	file: t.File,
	options: AnalyzeOptions = {},
): SobxModule {
	return new ModuleAnalyzer(file, options).run();
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** The role a function plays, which determines the context of accesses inside it. */
type FunctionRole =
	| { kind: "tracked"; by: DerivationId }
	| { kind: "effect"; reaction: ReactionId }
	| { kind: "action"; action: ActionId };

/** An access before ids are assigned. */
type PendingAccess = Access extends infer A
	? A extends Access
		? Omit<A, "id">
		: never
	: never;

type Receiver = "binding" | "this";

/** A member before annotations are resolved. */
interface RawMember {
	key: string;
	memberKind: ObservableMember["memberKind"];
	valueKind: ValueKind;
	static: boolean;
	accessor: boolean;
	/** The function implementing a getter / method, or a field's value. */
	value: t.Node | null;
	decorators: t.Decorator[];
	span: Span;
}

/** Inference defaults from an observable's options argument. */
interface InferenceDefaults {
	autoBind: boolean;
	deep: boolean;
}

interface ExplicitAnnotations {
	entries: Map<string, { annotation: Annotation | "infer"; span: Span }>;
	open: boolean;
}

class ModuleAnalyzer {
	private readonly moduleSpecifier: string;
	private readonly filename: string | null;

	private readonly imports: SobxImport[] = [];
	private readonly observables: Observable[] = [];
	private readonly computeds: Computed[] = [];
	private readonly reactions: Reaction[] = [];
	private readonly actions: Action[] = [];
	private readonly unsupported: UnsupportedUsage[] = [];
	private readonly diagnostics: Diagnostic[] = [];
	private readonly pendingAccesses: PendingAccess[] = [];

	/** Identifier nodes that reference an API import, mapped to the API. */
	private readonly apiRefs = new Map<t.Node, KnownApi>();
	/** Direct calls to modeled APIs. */
	private readonly calls = new Map<ModeledApi, NodePath<t.CallExpression>[]>();
	/** Function nodes mapped to their role. */
	private readonly functionRoles = new Map<t.Node, FunctionRole>();
	/** `action(...)` call nodes mapped to the action they create. */
	private readonly actionCalls = new Map<t.Node, ActionId>();
	/** Bindings holding observable objects or class instances. */
	private readonly observableBindings = new Map<BabelBinding, ObservableId>();
	/** Bindings holding boxed computeds. */
	private readonly computedBindings = new Map<BabelBinding, ComputedId>();
	/** Object literal / class nodes whose `this` refers to an observable. */
	private readonly thisOwners = new Map<
		t.Node,
		{ id: ObservableId; path: NodePath }
	>();
	/** `this` arguments of `makeObservable(this, ...)` calls. */
	private readonly makeTargets = new Set<t.Node>();
	/** API references used as decorators. */
	private readonly decoratorRefs: NodePath[] = [];
	/** Reassignments already reported, so each is reported once. */
	private readonly reportedViolations = new Set<t.Node>();
	/** The function directly containing each access (for indirect dependencies). */
	private readonly accessFns = new Map<PendingAccess, t.Node | null>();
	/** Function-valued members by `${observableId}|${key}` (pre-renumber ids). */
	private readonly memberFns = new Map<
		string,
		{ node: t.Node; untracked: boolean }
	>();
	/** `await`s directly inside each async function. */
	private readonly awaitCache = new Map<
		t.Node,
		{ awaits: t.Node[]; forAwaits: t.ForOfStatement[] }
	>();
	private functionPathIndex: Map<t.Node, NodePath> | null = null;
	private program: NodePath<t.Program> | null = null;
	/** Classes made observable, with their bindings. */
	private readonly classes = new Map<
		t.Node,
		{ observable: ClassObservable; binding: BabelBinding | null }
	>();

	constructor(
		private readonly file: t.File,
		options: AnalyzeOptions,
	) {
		this.moduleSpecifier = options.moduleSpecifier ?? DEFAULT_MODULE_SPECIFIER;
		this.filename = options.filename ?? null;
	}

	run(): SobxModule {
		const program = getProgramPath(this.file);
		this.program = program;
		this.collectImports(program);

		// action() calls first, so observable members holding them can link to them.
		for (const call of this.sortedCalls("action")) this.visitActionCall(call);

		// Observables (ids in source order), including their getters / methods.
		for (const call of this.sortedCalls(
			"observable",
			"makeObservable",
			"makeAutoObservable",
		)) {
			const api = this.apiRefs.get(call.node.callee) as Exclude<
				ObservableSource,
				"decorators"
			>;
			if (api === "observable") this.visitObservableCall(call);
			else this.visitMakeObservableCall(call, api);
		}

		this.registerDecoratedClasses();

		// Derivations and remaining actions, so accesses can be attributed to them.
		for (const call of this.sortedCalls("reaction", "autorun")) {
			this.visitReactionCall(call);
		}
		for (const call of this.sortedCalls("computed")) {
			this.visitComputedCall(call);
		}
		for (const call of this.sortedCalls("runInAction")) {
			this.visitRunInActionCall(call);
		}

		// Instances of observable classes.
		for (const { observable, binding } of this.classes.values()) {
			if (binding) this.visitClassReferences(binding, observable);
		}

		// Every reference to an observable.
		for (const [binding, id] of this.observableBindings) {
			for (const ref of valueReferences(binding)) {
				this.classifyReference(ref, id, "binding");
			}
		}
		for (const [owner, { id, path }] of this.thisOwners) {
			this.visitThisReferences(owner, path, id);
		}
		for (const [binding, id] of this.computedBindings) {
			for (const ref of valueReferences(binding)) {
				this.classifyComputedReference(ref, id);
			}
		}

		const accesses = this.finalizeAccesses();
		this.renumber(accesses);

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
			computeds: this.computeds,
			accesses,
			reactions: this.reactions,
			actions: this.actions,
			unsupported: this.unsupported,
			diagnostics: this.diagnostics,
		};
	}

	// -- imports --------------------------------------------------------------

	/** Records imports from the module specifier and classifies every reference to them. */
	private collectImports(program: NodePath<t.Program>): void {
		const refs: Array<{ ref: NodePath; api: KnownApi | null; local: string }> =
			[];

		for (const stmt of program.get("body")) {
			if (!stmt.isImportDeclaration()) continue;
			if (stmt.node.source.value !== this.moduleSpecifier) continue;
			if (stmt.node.importKind === "type") continue;

			for (const spec of stmt.node.specifiers) {
				const local = spec.local.name;
				const span = toSpan(spec);

				if (t.isImportNamespaceSpecifier(spec)) {
					this.imports.push({ kind: "NamespaceImport", local, span });
					this.diagnose(
						"namespace-import",
						"error",
						`Namespace import "${local}" from "${this.moduleSpecifier}" is not analyzed; use named imports.`,
						span,
					);
					continue;
				}
				if (t.isImportDefaultSpecifier(spec)) {
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

				const imported = t.isIdentifier(spec.imported)
					? spec.imported.name
					: spec.imported.value;
				const api = toKnownApi(imported);
				this.imports.push({ kind: "NamedImport", imported, local, api, span });
				if (api === null) {
					this.diagnose(
						"unknown-import",
						"warning",
						`"${imported}" is not a known export of "${this.moduleSpecifier}".`,
						span,
					);
				}

				const binding = program.scope.getBinding(local);
				if (!binding) continue;
				for (const ref of valueReferences(binding)) {
					if (api !== null) this.apiRefs.set(ref.node, api);
					refs.push({ ref, api, local });
				}
			}
		}

		// Classify only once every API reference is known, so annotation positions resolve.
		refs.sort((a, b) => (a.ref.node.start ?? 0) - (b.ref.node.start ?? 0));
		for (const { ref, api, local } of refs) {
			this.classifyApiReference(ref, api, local);
		}
	}

	private classifyApiReference(
		ref: NodePath,
		api: KnownApi | null,
		local: string,
	): void {
		// `observable.ref`, `action.bound`, ...
		let expr: NodePath = ref;
		let memberName: string | null = null;
		const parent = ref.parentPath;
		if (
			parent?.isMemberExpression() &&
			parent.node.object === ref.node &&
			!parent.node.computed &&
			t.isIdentifier(parent.node.property)
		) {
			memberName = parent.node.property.name;
			expr = parent;
		}
		const call =
			expr.parentPath?.isCallExpression() &&
			expr.parentPath.node.callee === expr.node
				? (expr.parentPath as NodePath<t.CallExpression>)
				: null;
		const isAnnotation = this.isAnnotationPosition(call ?? expr);
		const span = toSpan(ref.node);

		if (api === null || UNMODELED_APIS.has(api)) {
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

		if (isAnnotation) {
			if ((call ?? expr).parentPath?.isDecorator())
				this.decoratorRefs.push(ref);
			return;
		}

		if (memberName !== null) {
			this.diagnose(
				"unsupported-api",
				"error",
				`"${local}.${memberName}" is not supported by sobx yet.`,
				toSpan(expr.node),
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

		const modeled = api as ModeledApi;
		const list = this.calls.get(modeled) ?? [];
		list.push(call);
		this.calls.set(modeled, list);
	}

	/**
	 * Whether `path` is an annotation: a decorator, or a property value in the annotations /
	 * overrides object of `observable` / `makeObservable` / `makeAutoObservable`.
	 */
	private isAnnotationPosition(path: NodePath): boolean {
		const parent = path.parentPath;
		if (parent?.isDecorator()) return true;
		if (!parent?.isObjectProperty() || parent.node.value !== path.node) {
			return false;
		}
		const object = parent.parentPath;
		const call = object?.parentPath;
		if (!object || !call?.isCallExpression()) return false;
		if (call.node.arguments[1] !== object.node) return false;
		const api = this.apiRefs.get(call.node.callee);
		return api !== undefined && ANNOTATING_APIS.has(api);
	}

	private sortedCalls(...apis: ModeledApi[]): NodePath<t.CallExpression>[] {
		return sortByStart(apis.flatMap((api) => this.calls.get(api) ?? []));
	}

	// -- observable() -----------------------------------------------------------

	private visitObservableCall(call: NodePath<t.CallExpression>): void {
		const [arg, overrides] = call.node.arguments;
		if (!arg || !t.isExpression(arg)) {
			this.diagnose(
				"invalid-arguments",
				"error",
				"observable() expects an initial value as its first argument.",
				toSpan(call.node),
			);
		}
		this.createObjectObservable(
			call,
			"observable",
			arg && t.isObjectExpression(arg)
				? (call.get("arguments.0") as NodePath<t.ObjectExpression>)
				: null,
			overrides,
		);
	}

	private visitMakeObservableCall(
		call: NodePath<t.CallExpression>,
		api: "makeObservable" | "makeAutoObservable",
	): void {
		const [target, annotations] = call.node.arguments;
		const span = toSpan(call.node);

		if (target && t.isObjectExpression(target)) {
			this.createObjectObservable(
				call,
				api,
				call.get("arguments.0") as NodePath<t.ObjectExpression>,
				annotations,
			);
			return;
		}

		if (!target || !t.isThisExpression(target)) {
			this.diagnose(
				"unsupported-target",
				"error",
				`${api}() target must be \`this\` (in a class constructor) or an object literal.`,
				target ? toSpan(target) : span,
			);
			return;
		}

		this.makeTargets.add(target);
		const classPath = enclosingConstructorClass(call);
		if (!classPath) {
			this.diagnose(
				"make-observable-outside-constructor",
				"error",
				`${api}(this) must be called directly in a class constructor.`,
				span,
			);
			return;
		}
		if (this.classes.has(classPath.node)) {
			this.diagnose(
				"unsupported-target",
				"error",
				`Class is already made observable; multiple ${api}() calls are not supported.`,
				span,
			);
			return;
		}

		this.createClassObservable(
			classPath,
			api,
			annotations,
			optionsArgument(call),
			span,
		);
	}

	private createClassObservable(
		classPath: NodePath<t.Class>,
		source: ObservableSource,
		annotations: t.Node | undefined,
		options: Options | null,
		span: Span,
	): void {
		const id = this.nextObservableId();
		const name = className(classPath);
		const classBinding = name
			? classPath.parentPath?.scope.getBinding(name)
			: null;
		const exported =
			(classBinding ? isExported(classBinding) : false) ||
			(classPath.parentPath?.isExportDeclaration() ?? false);

		const raw = classMembers(classPath.node, (n) => this.valueKindOf(n));
		const shape = this.buildShape(id, source, raw, annotations, options, span);

		const observable: ClassObservable = {
			kind: "Observable",
			id,
			source,
			target: "class",
			className: name,
			exported,
			instances: [],
			shape,
			options,
			classSpan: toSpan(classPath.node),
			span,
		};
		this.observables.push(observable);
		this.classes.set(classPath.node, {
			observable,
			binding: classBinding ?? null,
		});
		this.thisOwners.set(classPath.node, { id, path: classPath });

		if (exported) {
			this.diagnose(
				"observable-escape",
				"error",
				`Observable class "${name ?? "<anonymous>"}" is exported; instances created in other modules are not tracked.`,
				toSpan(classPath.node.id ?? classPath.node),
				[id],
			);
		}
	}

	private createObjectObservable(
		call: NodePath<t.CallExpression>,
		source: ObservableSource,
		object: NodePath<t.ObjectExpression> | null,
		annotations: t.Node | undefined,
	): void {
		const id = this.nextObservableId();
		const span = toSpan(call.node);
		const options = optionsArgument(call);
		const shape: ObservableShape = object
			? this.buildShape(
					id,
					source,
					objectMembers(object.node, (n) => this.valueKindOf(n)),
					annotations,
					options,
					span,
				)
			: { kind: "unknown" };
		const value = call.node.arguments[0];
		if (!object && value && isCollection(value)) {
			this.diagnose(
				"observable-collection",
				"error",
				"Observable arrays, Maps and Sets are not supported yet; use a plain object.",
				toSpan(value),
				[id],
			);
		}

		const outer = outerExpression(call);
		const resolved = resolveResultBinding(outer);
		if (resolved) {
			this.registerObservableBinding(resolved, outer, id);
			if (isDeclaredExported(resolved.babel)) {
				this.diagnose(
					"observable-escape",
					"error",
					`Observable "${resolved.binding.name}" is exported; accesses in other modules are not tracked.`,
					toSpan(resolved.babel.identifier),
					[id],
				);
			}
		} else {
			this.diagnose(
				"unbound-observable",
				"error",
				`${source}() result must be stored in a variable to be analyzed.`,
				span,
				[id],
			);
		}

		const observable: ObjectObservable = {
			kind: "Observable",
			id,
			source,
			target: "object",
			binding: resolved?.binding ?? null,
			shape,
			options,
			span,
		};
		this.observables.push(observable);
		if (object) this.thisOwners.set(object.node, { id, path: object });
	}

	private nextObservableId(): ObservableId {
		return `observable:${this.observables.length}`;
	}

	/**
	 * Map a binding to the observable created at `outer`. A binding that already holds an
	 * observable is reported once, whichever creation is processed first.
	 */
	private registerObservableBinding(
		resolved: { binding: Binding; babel: BabelBinding },
		outer: NodePath,
		id: ObservableId,
	): void {
		if (this.observableBindings.has(resolved.babel)) {
			const assignment = outer.parentPath?.isAssignmentExpression()
				? outer.parentPath.node
				: null;
			if (assignment && this.reportedViolations.has(assignment)) return;
			if (assignment) this.reportedViolations.add(assignment);
			this.diagnose(
				"observable-reassigned",
				"error",
				`"${resolved.binding.name}" is assigned more than one observable.`,
				toSpan(assignment ?? outer.node),
				[id],
			);
			return;
		}
		this.observableBindings.set(resolved.babel, id);
		this.checkReassignments(resolved.babel, outer, id);
	}

	private checkReassignments(
		binding: BabelBinding,
		creation: NodePath,
		id: ObservableId | ComputedId,
	): void {
		for (const violation of binding.constantViolations) {
			if (
				violation.isAssignmentExpression() &&
				violation.node.right === creation.node
			) {
				continue;
			}
			if (this.reportedViolations.has(violation.node)) continue;
			this.reportedViolations.add(violation.node);
			this.diagnose(
				"observable-reassigned",
				"error",
				`"${binding.identifier.name}" is reassigned; references may not point at the observable.`,
				toSpan(violation.node),
				[id],
			);
		}
	}

	// -- annotations & members ------------------------------------------------

	/** Resolve each member's annotation and create computeds / actions for them. */
	private buildShape(
		observable: ObservableId,
		source: ObservableSource,
		raw: { members: RawMember[]; open: boolean },
		annotationsArg: t.Node | undefined,
		options: Options | null,
		callSpan: Span,
	): ObservableShape {
		const explicit = this.explicitAnnotations(annotationsArg, source);
		const useDecorators =
			source === "decorators" ||
			(source === "makeObservable" && !annotationsArg);
		const defaults = this.inferenceDefaults(options, observable, callSpan);

		const members: ObservableMember[] = raw.members.map((m) =>
			this.resolveMember(
				observable,
				source,
				m,
				explicit,
				useDecorators,
				defaults,
			),
		);

		if (explicit && !raw.open) {
			for (const [key, { span }] of explicit.entries) {
				if (!raw.members.some((m) => m.key === key && !m.static)) {
					this.diagnose(
						"unknown-annotation-key",
						"warning",
						`Annotation for "${key}" does not match any member.`,
						span,
						[observable],
					);
				}
			}
		}

		if (
			source === "makeObservable" &&
			!explicit &&
			!members.some((m) => m.annotation !== null)
		) {
			this.diagnose(
				"missing-annotations",
				"warning",
				"makeObservable() without an annotations object or decorators makes nothing observable.",
				callSpan,
				[observable],
			);
		}

		return { kind: "object", members, open: raw.open };
	}

	/**
	 * Classes that use API decorators but never call `makeObservable(this)` rely on standard
	 * (2022.3) decorators, which need no call. Model them from their decorators.
	 */
	private registerDecoratedClasses(): void {
		for (const ref of sortByStart(this.decoratorRefs)) {
			const cls = ref.findParent((p) =>
				p.isClass(),
			) as NodePath<t.Class> | null;
			if (!cls || this.classes.has(cls.node)) continue;
			this.createClassObservable(
				cls,
				"decorators",
				undefined,
				null,
				toSpan(cls.node),
			);
		}
	}

	/** Read `autoBind` / `deep` from an options argument. */
	private inferenceDefaults(
		options: Options | null,
		observable: ObservableId,
		callSpan: Span,
	): InferenceDefaults {
		const defaults: InferenceDefaults = { autoBind: false, deep: true };
		if (!options) return defaults;

		let unresolved = options.kind === "unknown" || options.open;
		if (options.kind === "object") {
			for (const key of ["autoBind", "deep"] as const) {
				const entry = options.entries[key];
				if (!entry) continue;
				if (entry.kind === "literal" && typeof entry.value === "boolean") {
					defaults[key] = entry.value;
				} else {
					unresolved = true;
				}
			}
		}
		if (unresolved) {
			this.diagnose(
				"invalid-arguments",
				"warning",
				"Options could not be resolved statically; inferred annotations assume `autoBind: false` and `deep: true`.",
				options.kind === "unknown" ? options.span : callSpan,
				[observable],
			);
		}
		return defaults;
	}

	private explicitAnnotations(
		node: t.Node | undefined,
		source: ObservableSource,
	): ExplicitAnnotations | null {
		if (!node) return null;
		if (!t.isObjectExpression(node)) {
			this.diagnose(
				"invalid-arguments",
				"error",
				`${source}() annotations must be an object literal to be analyzed.`,
				toSpan(node),
			);
			return { entries: new Map(), open: true };
		}
		const entries: ExplicitAnnotations["entries"] = new Map();
		let open = false;
		for (const prop of node.properties) {
			if (t.isSpreadElement(prop)) {
				open = true;
				continue;
			}
			const key = propertyKey(prop.key, prop.computed);
			if (key.kind === "dynamic") {
				open = true;
				continue;
			}
			const annotation = t.isObjectMethod(prop)
				? ({ kind: "unknown" } as const)
				: this.parseAnnotation(prop.value);
			entries.set(key.name, { annotation, span: toSpan(prop) });
		}
		if (open) {
			this.diagnose(
				"invalid-arguments",
				"warning",
				"Annotations object has spreads or computed keys; annotations may be incomplete.",
				toSpan(node),
			);
		}
		return { entries, open };
	}

	/** Resolve an annotation expression. `"infer"` means `true` (use the default). */
	private parseAnnotation(node: t.Node): Annotation | "infer" {
		if (t.isBooleanLiteral(node)) {
			return node.value ? "infer" : { kind: "excluded" };
		}
		const callee = t.isCallExpression(node) ? node.callee : node;

		const base = this.apiRefs.get(callee);
		if (base !== undefined) {
			switch (base) {
				case "observable":
					return { kind: "observable", modifier: "deep" };
				case "computed":
					return { kind: "computed", modifier: "default" };
				case "action":
					return { kind: "action", bound: false };
				case "flow":
					return { kind: "flow", bound: false };
				default:
					return { kind: "unknown" };
			}
		}

		if (
			t.isMemberExpression(callee) &&
			!callee.computed &&
			t.isIdentifier(callee.property)
		) {
			const api = this.apiRefs.get(callee.object);
			const modifier = callee.property.name;
			if (
				api === "observable" &&
				(modifier === "deep" ||
					modifier === "ref" ||
					modifier === "shallow" ||
					modifier === "struct")
			) {
				return { kind: "observable", modifier };
			}
			if (api === "computed" && modifier === "struct") {
				return { kind: "computed", modifier: "struct" };
			}
			if (api === "action" && modifier === "bound") {
				return { kind: "action", bound: true };
			}
			if (api === "flow" && modifier === "bound") {
				return { kind: "flow", bound: true };
			}
		}
		return { kind: "unknown" };
	}

	private resolveMember(
		observable: ObservableId,
		source: ObservableSource,
		m: RawMember,
		explicit: ExplicitAnnotations | null,
		useDecorators: boolean,
		defaults: InferenceDefaults,
	): ObservableMember {
		let annotation: Annotation | null = null;
		let annotationSource: ObservableMember["annotationSource"] = null;

		if (!m.static) {
			const written = explicit?.entries.get(m.key)?.annotation;
			const decorated = useDecorators ? this.decoratorAnnotation(m) : null;
			if (written !== undefined) {
				annotation =
					written === "infer" ? inferAnnotation(m, defaults) : written;
				annotationSource = written === "infer" ? "inferred" : "explicit";
			} else if (decorated) {
				annotation =
					decorated === "infer" ? inferAnnotation(m, defaults) : decorated;
				annotationSource = "decorator";
			} else if (source === "observable" || source === "makeAutoObservable") {
				annotation = inferAnnotation(m, defaults);
				annotationSource = "inferred";
			}
		}

		const member: ObservableMember = {
			key: m.key,
			memberKind: m.memberKind,
			valueKind: m.valueKind,
			static: m.static,
			accessor: m.accessor,
			annotation,
			annotationSource,
			computed: null,
			action: null,
			span: m.span,
		};
		if (annotation) {
			this.applyAnnotation(observable, source, m, member, annotation);
		}
		if (
			!m.static &&
			m.value &&
			(t.isObjectMethod(m.value) ||
				t.isClassMethod(m.value) ||
				t.isArrowFunctionExpression(m.value) ||
				t.isFunctionExpression(m.value)) &&
			m.memberKind !== "getter"
		) {
			this.memberFns.set(`${observable}|${m.key}`, {
				node: m.value,
				// `action` runs untracked; `autoAction` and plain functions run tracked.
				untracked: annotation?.kind === "action",
			});
		}
		return member;
	}

	private decoratorAnnotation(m: RawMember): Annotation | "infer" | null {
		for (const decorator of m.decorators) {
			const parsed = this.parseAnnotation(decorator.expression);
			if (parsed === "infer" || parsed.kind !== "unknown") return parsed;
		}
		return null;
	}

	/** Validate an annotation against its member and create the backing computed / action. */
	private applyAnnotation(
		observable: ObservableId,
		source: ObservableSource,
		m: RawMember,
		member: ObservableMember,
		annotation: Annotation,
	): void {
		const invalid = (message: string) =>
			this.diagnose("invalid-annotation", "error", message, m.span, [
				observable,
			]);

		switch (annotation.kind) {
			case "observable":
				if (m.memberKind !== "field") {
					invalid(`"${m.key}" is a ${m.memberKind}; it cannot be observable.`);
				} else if (source === "decorators" && !m.accessor) {
					invalid(
						`"${m.key}" needs \`accessor\` to be observable with standard decorators (or call makeObservable(this) when using legacy decorators).`,
					);
				}
				return;
			case "computed": {
				if (m.memberKind !== "getter" || !m.value) {
					invalid(`"${m.key}" must be a getter to be computed.`);
					return;
				}
				const id: ComputedId = `computed:${this.computeds.length}`;
				this.computeds.push({
					kind: "Computed",
					id,
					source: { kind: "getter", observable, key: m.key },
					body: this.functionRef(m.value, { kind: "tracked", by: id }),
					options: null,
					dependencies: [],
					indirectDependencies: [],
					span: m.span,
				});
				member.computed = id;
				return;
			}
			case "action":
			case "autoAction": {
				const existing = m.value ? this.actionCalls.get(m.value) : undefined;
				if (existing) {
					member.action = existing;
					return;
				}
				if (
					m.memberKind === "getter" ||
					(m.memberKind === "field" &&
						m.valueKind !== "function" &&
						m.valueKind !== "unknown")
				) {
					invalid(`"${m.key}" is not a function; it cannot be an action.`);
					return;
				}
				const id: ActionId = `action:${this.actions.length}`;
				const body = m.value
					? this.functionRef(m.value, { kind: "action", action: id })
					: ({ kind: "opaque", span: m.span } as const);
				if (body.kind === "opaque") {
					this.diagnose(
						"opaque-function",
						"warning",
						`Action "${m.key}" is not an inline function; its writes cannot be attributed to it.`,
						body.span,
						[id],
					);
				}
				this.actions.push({
					kind: "Action",
					id,
					source: {
						kind: "member",
						observable,
						key: m.key,
						annotation: annotation.kind,
						bound: annotation.bound,
					},
					body,
					writes: [],
					span: m.span,
				});
				member.action = id;
				return;
			}
			case "flow":
				// Explicit `flow` references are already reported at the reference.
				if (member.annotationSource === "inferred") {
					this.diagnose(
						"unsupported-api",
						"error",
						`"${m.key}" is a generator and would be inferred as a flow, which is not supported by sobx yet.`,
						m.span,
						[observable],
					);
				}
				return;
			case "unknown":
				invalid(`Could not resolve the annotation for "${m.key}".`);
				return;
			case "excluded":
				return;
		}
	}

	private valueKindOf(node: t.Node | null | undefined): ValueKind {
		if (!node) return "unknown";
		if (
			t.isCallExpression(node) &&
			this.apiRefs.get(node.callee) === "action"
		) {
			return "function";
		}
		return valueKind(node);
	}

	// -- reaction() / autorun() ---------------------------------------------------

	private visitReactionCall(call: NodePath<t.CallExpression>): void {
		const api = this.apiRefs.get(call.node.callee) as "reaction" | "autorun";
		const span = toSpan(call.node);
		const id: ReactionId = `reaction:${this.reactions.length}`;
		const disposerUsed =
			!outerExpression(call).parentPath?.isExpressionStatement();

		if (api === "autorun") {
			const [bodyArg, optionsArg] = call.node.arguments;
			if (!bodyArg || !t.isExpression(bodyArg)) {
				this.diagnose(
					"invalid-arguments",
					"error",
					"autorun() expects a function.",
					span,
				);
				return;
			}
			const body = this.functionRef(bodyArg, { kind: "tracked", by: id });
			if (body.kind === "opaque")
				this.opaqueTracked("autorun() body", body, id);
			this.reactions.push({
				kind: "Reaction",
				id,
				api,
				body,
				options: optionsArg ? optionsOf(optionsArg) : null,
				dependencies: [],
				indirectDependencies: [],
				disposerUsed,
				span,
			});
			return;
		}

		const [dataArg, effectArg, optionsArg] = call.node.arguments;
		if (
			!dataArg ||
			!effectArg ||
			!t.isExpression(dataArg) ||
			!t.isExpression(effectArg)
		) {
			this.diagnose(
				"invalid-arguments",
				"error",
				"reaction() expects a data function and an effect function.",
				span,
			);
			return;
		}
		const data = this.functionRef(dataArg, { kind: "tracked", by: id });
		const effect = this.functionRef(effectArg, {
			kind: "effect",
			reaction: id,
		});
		if (data.kind === "opaque") {
			this.opaqueTracked("reaction() data function", data, id);
		}
		this.reactions.push({
			kind: "Reaction",
			id,
			api,
			data,
			effect,
			options: optionsArg ? optionsOf(optionsArg) : null,
			dependencies: [],
			indirectDependencies: [],
			disposerUsed,
			span,
		});
	}

	private opaqueTracked(what: string, fn: FunctionRef, id: DerivationId): void {
		this.diagnose(
			"opaque-function",
			"error",
			`${what} must be an inline function so its dependencies can be analyzed.`,
			fn.span,
			[id],
		);
	}

	// -- computed() ---------------------------------------------------------------

	private visitComputedCall(call: NodePath<t.CallExpression>): void {
		const [bodyArg, optionsArg] = call.node.arguments;
		const span = toSpan(call.node);
		if (!bodyArg || !t.isExpression(bodyArg)) {
			this.diagnose(
				"invalid-arguments",
				"error",
				"computed() expects a function.",
				span,
			);
			return;
		}

		const id: ComputedId = `computed:${this.computeds.length}`;
		const body = this.functionRef(bodyArg, { kind: "tracked", by: id });
		if (body.kind === "opaque") this.opaqueTracked("computed() body", body, id);

		const outer = outerExpression(call);
		const resolved = resolveResultBinding(outer);
		if (resolved) {
			this.computedBindings.set(resolved.babel, id);
			this.checkReassignments(resolved.babel, outer, id);
		} else {
			this.diagnose(
				"unbound-observable",
				"error",
				"computed() result must be stored in a variable to be analyzed.",
				span,
				[id],
			);
		}

		this.computeds.push({
			kind: "Computed",
			id,
			source: { kind: "call", binding: resolved?.binding ?? null },
			body,
			options: optionsArg ? optionsOf(optionsArg) : null,
			dependencies: [],
			indirectDependencies: [],
			span,
		});
	}

	// -- runInAction() / action() -----------------------------------------------

	private visitRunInActionCall(call: NodePath<t.CallExpression>): void {
		const [bodyArg] = call.node.arguments;
		if (!bodyArg || !t.isExpression(bodyArg)) {
			this.diagnose(
				"invalid-arguments",
				"error",
				"runInAction() expects a function.",
				toSpan(call.node),
			);
			return;
		}
		this.createAction(call, bodyArg, { kind: "runInAction" });
	}

	private visitActionCall(call: NodePath<t.CallExpression>): void {
		const [first, second] = call.node.arguments;
		const named = first && t.isStringLiteral(first);
		const bodyArg = named ? second : first;
		if (!bodyArg || !t.isExpression(bodyArg)) {
			this.diagnose(
				"invalid-arguments",
				"error",
				"action() expects a function (optionally preceded by a name).",
				toSpan(call.node),
			);
			return;
		}
		const resolved = resolveResultBinding(outerExpression(call));
		const id = this.createAction(call, bodyArg, {
			kind: "action",
			name: named ? (first as t.StringLiteral).value : null,
			binding: resolved?.binding ?? null,
		});
		this.actionCalls.set(call.node, id);
	}

	private createAction(
		call: NodePath<t.CallExpression>,
		bodyArg: t.Expression,
		source: ActionSource,
	): ActionId {
		const id: ActionId = `action:${this.actions.length}`;
		const body = this.functionRef(bodyArg, { kind: "action", action: id });
		if (body.kind === "opaque") {
			this.diagnose(
				"opaque-function",
				"warning",
				`${source.kind}() body is not an inline function; its writes cannot be attributed to the action.`,
				body.span,
				[id],
			);
		}
		this.actions.push({
			kind: "Action",
			id,
			source,
			body,
			writes: [],
			span: toSpan(call.node),
		});
		return id;
	}

	private functionRef(node: t.Node, role: FunctionRole): FunctionRef {
		if (
			t.isArrowFunctionExpression(node) ||
			t.isFunctionExpression(node) ||
			t.isObjectMethod(node) ||
			t.isClassMethod(node) ||
			t.isClassPrivateMethod(node)
		) {
			this.functionRoles.set(node, role);
			return {
				kind: "inline",
				params: runtimeParamCount(node.params),
				async: node.async,
				span: toSpan(node),
			};
		}
		return { kind: "opaque", span: toSpan(node) };
	}

	// -- class references ---------------------------------------------------------

	/** Classify references to an observable class: `new Store()` creates tracked instances. */
	private visitClassReferences(
		binding: BabelBinding,
		observable: ClassObservable,
	): void {
		const name = binding.identifier.name;
		for (const ref of valueReferences(binding)) {
			const r = outerExpression(ref);
			const parent = r.parentPath;
			if (!parent) continue;

			if (parent.isNewExpression() && parent.node.callee === r.node) {
				const outer = outerExpression(parent);
				const resolved = resolveResultBinding(outer);
				if (!resolved) {
					this.diagnose(
						"observable-escape",
						"error",
						`Instance of observable class "${name}" is not stored in a variable; accesses through it are not tracked.`,
						toSpan(parent.node),
						[observable.id],
					);
					continue;
				}
				observable.instances.push(resolved.binding);
				this.registerObservableBinding(resolved, outer, observable.id);
				continue;
			}

			// Static member access, `instanceof`, and identity checks do not involve instances.
			if (
				((parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
					parent.node.object === r.node) ||
				(parent.isBinaryExpression() &&
					["instanceof", "===", "!==", "==", "!="].includes(
						parent.node.operator,
					)) ||
				parent.isExpressionStatement()
			) {
				continue;
			}
			if (parent.isExportSpecifier()) continue; // reported via `exported`

			this.diagnose(
				"observable-escape",
				"error",
				`Observable class "${name}" escapes analysis (${describeEscape(parent, r)}); instances created through other references are not tracked.`,
				toSpan(r.node),
				[observable.id],
			);
		}
	}

	// -- this references ----------------------------------------------------------

	private visitThisReferences(
		owner: t.Node,
		path: NodePath,
		observable: ObservableId,
	): void {
		const refs: NodePath[] = [];
		path.traverse({
			ThisExpression: (p) => {
				if (this.makeTargets.has(p.node)) return;
				if (thisOwner(p) === owner) refs.push(p);
			},
		});
		for (const ref of sortByStart(refs)) {
			this.classifyReference(ref, observable, "this");
		}
	}

	// -- observable references --------------------------------------------------

	private classifyReference(
		ref: NodePath,
		observable: ObservableId,
		receiver: Receiver,
	): void {
		const name = referenceName(ref);
		const r = outerExpression(ref);
		const parent = r.parentPath;
		if (!parent) return;
		const context = this.contextOf(ref);

		// store.key / store[key] / store?.key
		if (
			(parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
			parent.node.object === r.node
		) {
			const key = memberKey(parent.node);
			this.checkDynamicKey(key, context, parent.node, observable);
			this.pushAccess(
				memberAccess(parent, observable, key, receiver, context),
				ref,
			);
			this.checkDeepMutation(parent, observable, key, receiver, context);
			return;
		}

		// const { a, b } = store  /  ({ a, b } = store)
		const pattern =
			parent.isVariableDeclarator() &&
			parent.node.init === r.node &&
			t.isObjectPattern(parent.node.id)
				? parent.node.id
				: parent.isAssignmentExpression() &&
						parent.node.right === r.node &&
						t.isObjectPattern(parent.node.left)
					? parent.node.left
					: null;
		if (pattern) {
			this.visitDestructure(pattern, observable, receiver, context, name, ref);
			return;
		}

		if (isHarmlessUse(parent)) return;

		// `k in store`
		if (
			parent.isBinaryExpression() &&
			parent.node.operator === "in" &&
			parent.node.right === r.node
		) {
			this.diagnose(
				"unsupported-operation",
				"error",
				`The "in" operator on observable "${name}" is not supported.`,
				toSpan(parent.node),
				[observable],
			);
			return;
		}

		// for (k in store)
		if (parent.isForInStatement() && parent.node.right === r.node) {
			this.diagnose(
				"unsupported-operation",
				"error",
				`Enumerating observable "${name}" with for...in is not supported.`,
				toSpan(r.node),
				[observable],
			);
			return;
		}

		// Object.keys(store) etc.
		if (
			parent.isCallExpression() &&
			parent.node.arguments.includes(r.node as t.Expression)
		) {
			const callee = parent.node.callee;
			if (
				t.isMemberExpression(callee) &&
				t.isIdentifier(callee.object, { name: "Object" }) &&
				t.isIdentifier(callee.property) &&
				OBJECT_ENUMERATORS.has(callee.property.name) &&
				!parent.scope.getBinding("Object")
			) {
				this.diagnose(
					"unsupported-operation",
					"error",
					`Object.${callee.property.name}() on observable "${name}" is not supported.`,
					toSpan(parent.node),
					[observable],
				);
				return;
			}
		}

		this.diagnose(
			"observable-escape",
			"error",
			`Observable "${name}" escapes analysis (${describeEscape(parent, r)}); accesses through other references are not tracked.`,
			toSpan(r.node),
			[observable],
		);
	}

	private classifyComputedReference(ref: NodePath, computed: ComputedId): void {
		const name = referenceName(ref);
		const r = outerExpression(ref);
		const parent = r.parentPath;
		if (!parent) return;

		if (
			(parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
			parent.node.object === r.node
		) {
			const key = memberKey(parent.node);
			const call = outerExpression(parent).parentPath;
			const isCall =
				(call?.isCallExpression() || call?.isOptionalCallExpression()) &&
				call.node.callee === outerExpression(parent).node;
			if (key.kind === "static" && key.name === "get" && isCall && call) {
				this.pushAccess(
					{
						kind: "ComputedRead",
						computed,
						context: this.contextOf(ref),
						span: toSpan(call.node),
					},
					ref,
				);
				return;
			}
			this.diagnose(
				"unsupported-operation",
				"error",
				`Only ${name}.get() is supported on a computed.`,
				toSpan(parent.node),
				[computed],
			);
			return;
		}

		if (isHarmlessUse(parent)) return;

		this.diagnose(
			"observable-escape",
			"error",
			`Computed "${name}" escapes analysis (${describeEscape(parent, r)}); reads through other references are not tracked.`,
			toSpan(r.node),
			[computed],
		);
	}

	private visitDestructure(
		pattern: t.ObjectPattern,
		observable: ObservableId,
		receiver: Receiver,
		context: AccessContext,
		name: string,
		at: NodePath,
	): void {
		for (const prop of pattern.properties) {
			if (t.isRestElement(prop)) {
				this.diagnose(
					"observable-escape",
					"error",
					`Rest element copies every property of observable "${name}"; this is not tracked.`,
					toSpan(prop),
					[observable],
				);
				continue;
			}
			const key = propertyKey(prop.key, prop.computed);
			this.checkDynamicKey(key, context, prop, observable);
			this.pushAccess(
				{
					kind: "Read",
					via: "destructure",
					path: [],
					called: false,
					observable,
					key,
					receiver,
					// A fresh object per access: renumbering rewrites contexts in place.
					context: { ...context },
					span: toSpan(prop),
				},
				at,
			);
		}
	}

	/**
	 * Flag mutations through a nested value (`store.obj.x = 1`, `store.list.push(v)`), which
	 * are only recorded as a read of the top-level property.
	 */
	private checkDeepMutation(
		member: NodePath,
		observable: ObservableId,
		key: AccessKey,
		receiver: Receiver,
		context: AccessContext,
	): void {
		const first = outerExpression(member);
		let top = first;
		while (
			top.parentPath &&
			(top.parentPath.isMemberExpression() ||
				top.parentPath.isOptionalMemberExpression()) &&
			top.parentPath.node.object === top.node
		) {
			top = outerExpression(top.parentPath);
		}
		if (top === first) return;

		const name = key.kind === "static" ? key.name : "<dynamic>";
		const nested = memberAccess(top, observable, key, receiver, context);
		if (nested.kind !== "Read") {
			this.diagnose(
				"deep-mutation",
				"warning",
				`Mutation of a value nested in observable property "${name}" is not tracked.`,
				toSpan(top.node),
				[observable],
			);
			return;
		}

		const call = top.parentPath;
		if (!call?.isCallExpression() || call.node.callee !== top.node) return;
		const kind = this.propertyValueKind(observable, key);
		const method = t.isMemberExpression(top.node)
			? memberKey(top.node)
			: { kind: "dynamic" as const };
		const mutates =
			kind === "object" ||
			(kind === "array" &&
				(method.kind === "dynamic" || MUTATING_ARRAY_METHODS.has(method.name)));
		if (mutates) {
			this.diagnose(
				"deep-mutation",
				"warning",
				`Method call on ${kind} nested in observable property "${name}" may mutate it; this is not tracked.`,
				toSpan(call.node),
				[observable],
			);
		}
	}

	private propertyValueKind(
		observable: ObservableId,
		key: AccessKey,
	): ValueKind | null {
		if (key.kind !== "static") return null;
		const obs = this.observables.find((o) => o.id === observable);
		if (obs?.shape.kind !== "object") return null;
		return (
			obs.shape.members.find((m) => m.key === key.name && !m.static)
				?.valueKind ?? null
		);
	}

	private checkDynamicKey(
		key: AccessKey,
		context: AccessContext,
		node: t.Node,
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
			toSpan(node),
			[observable],
		);
	}

	private pushAccess(access: PendingAccess, at: NodePath): void {
		this.pendingAccesses.push(access);
		const fn = at.findParent((p) => p.isFunction());
		this.accessFns.set(access, fn?.node ?? null);
	}

	private awaitsIn(fn: NodePath): {
		awaits: t.Node[];
		forAwaits: t.ForOfStatement[];
	} {
		const cached = this.awaitCache.get(fn.node);
		if (cached) return cached;
		const result = {
			awaits: [] as t.Node[],
			forAwaits: [] as t.ForOfStatement[],
		};
		fn.traverse({
			Function(p) {
				p.skip();
			},
			AwaitExpression(p) {
				result.awaits.push(p.node);
			},
			ForOfStatement(p) {
				if (p.node.await) result.forAwaits.push(p.node);
			},
		});
		this.awaitCache.set(fn.node, result);
		return result;
	}

	/**
	 * Whether code at `path` may run after an `await` in `fn`: it follows an `await` in source
	 * order, is the target of an awaited assignment (`x.a = await f()`), or sits in a loop
	 * (or `for await`) that awaits.
	 */
	private isAfterAwait(path: NodePath, fn: NodePath): boolean {
		const { awaits, forAwaits } = this.awaitsIn(fn);
		if (awaits.length === 0 && forAwaits.length === 0) return false;
		const start = path.node.start ?? 0;
		const within = (n: t.Node, outer: t.Node) =>
			(n.start ?? 0) >= (outer.start ?? 0) && (n.end ?? 0) <= (outer.end ?? 0);

		if (awaits.some((a) => (a.end ?? 0) <= start)) return true;
		if (forAwaits.some((f) => (f.right.end ?? 0) <= start)) return true;

		for (let p = path.parentPath; p && p !== fn; p = p.parentPath) {
			if (p.isAssignmentExpression()) {
				const right = p.node.right;
				if (
					start < (right.start ?? 0) &&
					awaits.some((a) => within(a, right))
				) {
					return true;
				}
			}
			if (p.isLoop() && awaits.some((a) => within(a, p.node))) return true;
		}
		return false;
	}

	/** Find the innermost function with a role enclosing `path`. */
	private contextOf(path: NodePath): AccessContext {
		let crossedFunction = false;
		for (let p = path.parentPath; p; p = p.parentPath) {
			const role = this.functionRoles.get(p.node);
			if (role) {
				if (!crossedFunction) {
					if (
						role.kind !== "effect" &&
						(p.node as t.Function).async &&
						this.isAfterAwait(path, p)
					) {
						return {
							kind: "after-await",
							in: role.kind === "action" ? role.action : role.by,
						};
					}
					return { ...role };
				}
				if (role.kind === "tracked") {
					return { kind: "tracked-nested", by: role.by };
				}
				if (role.kind === "effect") return { ...role };
				// A function nested in an action body may run after the action completes.
				return { kind: "untracked" };
			}
			if (p.isFunction()) crossedFunction = true;
		}
		return { kind: "untracked" };
	}

	// -- finalize ---------------------------------------------------------------

	private finalizeAccesses(): Access[] {
		this.pendingAccesses.sort(
			(a, b) => a.span.start - b.span.start || a.span.end - b.span.end,
		);
		const accesses = this.pendingAccesses.map(
			(access, i) => ({ ...access, id: `access:${i}` }) as Access,
		);
		const fns = this.pendingAccesses.map((a) => this.accessFns.get(a) ?? null);

		const derivations = new Map<DerivationId, { dependencies: string[] }>([
			...this.reactions.map((r) => [r.id, r] as const),
			...this.computeds.map((c) => [c.id, c] as const),
		]);
		const actions = new Map(this.actions.map((a) => [a.id, a]));

		for (const access of accesses) {
			const ctx = access.context;
			const target =
				access.kind === "ComputedRead" ? access.computed : access.observable;
			const isRead = access.kind === "Read" || access.kind === "ComputedRead";

			if (ctx.kind === "tracked") {
				if (isRead) {
					derivations.get(ctx.by)?.dependencies.push(access.id);
				} else {
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
			} else if (ctx.kind === "action" && !isRead) {
				actions.get(ctx.action)?.writes.push(access.id);
			} else if (ctx.kind === "after-await") {
				const tracked = !ctx.in.startsWith("action:");
				if (!isRead) {
					this.diagnose(
						"after-await",
						"warning",
						tracked
							? "Write after `await` in a tracked function."
							: "Write after `await` runs outside the action; wrap it in runInAction().",
						access.span,
						[target, ctx.in, access.id],
					);
				} else if (tracked) {
					this.diagnose(
						"after-await",
						"warning",
						"Read after `await` in a tracked function is not tracked.",
						access.span,
						[target, ctx.in, access.id],
					);
				}
			}
		}

		this.computeIndirectDependencies(accesses, fns);
		return accesses;
	}

	/**
	 * Follow calls from each tracked function into local functions and observable methods,
	 * recording the reads inside them as indirect dependencies. Also reports imports used in
	 * those functions, which per-module analysis cannot resolve.
	 */
	private computeIndirectDependencies(
		accesses: Access[],
		fns: Array<t.Node | null>,
	): void {
		const readsByFn = new Map<t.Node, AccessId[]>();
		accesses.forEach((access, i) => {
			const fn = fns[i];
			if (!fn || (access.kind !== "Read" && access.kind !== "ComputedRead")) {
				return;
			}
			const list = readsByFn.get(fn) ?? [];
			list.push(access.id);
			readsByFn.set(fn, list);
		});

		const derivations = new Map<
			DerivationId,
			{ indirectDependencies: AccessId[] }
		>([
			...this.reactions.map((r) => [r.id, r] as const),
			...this.computeds.map((c) => [c.id, c] as const),
		]);
		const paths = this.functionPaths();

		for (const [root, role] of this.functionRoles) {
			if (role.kind !== "tracked") continue;
			const visited = new Set<t.Node>([root]);
			const queue: t.Node[] = [root];
			const reportedImports = new Set<BabelBinding>();

			while (queue.length > 0) {
				const fn = queue.pop() as t.Node;
				const path = paths.get(fn);
				if (!path) continue;
				path.traverse({
					Function(p) {
						p.skip();
					},
					// Optional calls (`s.m?.()`) run during tracking too.
					"CallExpression|OptionalCallExpression": (p) => {
						const target = this.resolveCallTarget(
							p as NodePath<t.CallExpression | t.OptionalCallExpression>,
						);
						if (target && !visited.has(target)) {
							visited.add(target);
							queue.push(target);
						}
					},
					Identifier: (p) => {
						this.checkImportedReference(p, role.by, reportedImports);
					},
				});
			}

			const indirect = [...visited]
				.filter((fn) => fn !== root)
				.flatMap((fn) => readsByFn.get(fn) ?? [])
				.sort((a, b) => accessIndex(a) - accessIndex(b));
			derivations.get(role.by)?.indirectDependencies.push(...indirect);
		}
	}

	/** The function a call invokes, if it is a local function or a method of an observable. */
	private resolveCallTarget(
		call: NodePath<t.CallExpression | t.OptionalCallExpression>,
	): t.Node | null {
		const callee = call.node.callee;
		if (t.isIdentifier(callee)) {
			const binding = call.scope.getBinding(callee.name);
			if (!binding) return null;
			if (binding.path.isFunctionDeclaration()) return binding.path.node;
			if (
				binding.path.isVariableDeclarator() &&
				binding.constantViolations.length === 0
			) {
				const init = binding.path.node.init;
				if (
					init &&
					(t.isArrowFunctionExpression(init) || t.isFunctionExpression(init))
				) {
					return init;
				}
			}
			return null;
		}
		if (
			!t.isMemberExpression(callee) &&
			!t.isOptionalMemberExpression(callee)
		) {
			return null;
		}
		const key = memberKey(callee);
		if (key.kind !== "static") return null;

		const object = call.get("callee.object") as NodePath;
		let observable: ObservableId | undefined;
		if (object.isThisExpression()) {
			const owner = thisOwner(object);
			observable = owner ? this.thisOwners.get(owner)?.id : undefined;
		} else if (object.isIdentifier()) {
			const binding = object.scope.getBinding(object.node.name);
			observable = binding ? this.observableBindings.get(binding) : undefined;
		}
		if (!observable) return null;
		const entry = this.memberFns.get(`${observable}|${key.name}`);
		return entry && !entry.untracked ? entry.node : null;
	}

	/** Report a member access / call on an import from another module, once per derivation. */
	private checkImportedReference(
		p: NodePath<t.Identifier>,
		derivation: DerivationId,
		reported: Set<BabelBinding>,
	): void {
		const parent = p.parentPath;
		const used =
			((parent?.isMemberExpression() || parent?.isOptionalMemberExpression()) &&
				parent.node.object === p.node) ||
			((parent?.isCallExpression() || parent?.isOptionalCallExpression()) &&
				parent.node.callee === p.node);
		if (!used || isInTypePosition(p)) return;

		const binding = p.scope.getBinding(p.node.name);
		if (binding?.kind !== "module" || reported.has(binding)) return;
		const spec = binding.path;
		const decl = spec.parentPath;
		if (!decl?.isImportDeclaration()) return;
		if (decl.node.source.value === this.moduleSpecifier) return;
		if (
			decl.node.importKind === "type" ||
			(spec.isImportSpecifier() && spec.node.importKind === "type")
		) {
			return;
		}

		reported.add(binding);
		this.diagnose(
			"unresolved-import",
			"warning",
			`"${p.node.name}" is imported from "${decl.node.source.value}" and used in a tracked function; whether it reads observables cannot be determined per module.`,
			toSpan(p.node),
			[derivation],
		);
	}

	private functionPaths(): Map<t.Node, NodePath> {
		if (this.functionPathIndex) return this.functionPathIndex;
		const index = new Map<t.Node, NodePath>();
		this.program?.traverse({
			Function(p) {
				index.set(p.node, p);
			},
		});
		this.functionPathIndex = index;
		return index;
	}

	/**
	 * Entities are discovered in dependency order (e.g. `action()` calls before observables,
	 * getters before `computed()` calls). Reassign ids in source order and rewrite every
	 * cross-reference.
	 */
	private renumber(accesses: Access[]): void {
		const obs = reorder(this.observables, "observable", (o) =>
			o.target === "class" ? o.classSpan.start : o.span.start,
		);
		const comp = reorder(this.computeds, "computed", (c) => c.span.start);
		const act = reorder(this.actions, "action", (a) => a.span.start);
		const react = reorder(this.reactions, "reaction", (r) => r.span.start);

		const o = (id: ObservableId) => (obs.get(id) ?? id) as ObservableId;
		const c = (id: ComputedId) => (comp.get(id) ?? id) as ComputedId;
		const a = (id: ActionId) => (act.get(id) ?? id) as ActionId;
		const r = (id: ReactionId) => (react.get(id) ?? id) as ReactionId;
		const d = (id: DerivationId): DerivationId =>
			id.startsWith("computed:") ? c(id as ComputedId) : r(id as ReactionId);
		const any = (id: string) =>
			obs.get(id) ?? comp.get(id) ?? act.get(id) ?? react.get(id) ?? id;

		for (const observable of this.observables) {
			if (observable.shape.kind !== "object") continue;
			for (const member of observable.shape.members) {
				if (member.computed) member.computed = c(member.computed);
				if (member.action) member.action = a(member.action);
			}
		}
		for (const computed of this.computeds) {
			if (computed.source.kind === "getter") {
				computed.source.observable = o(computed.source.observable);
			}
		}
		for (const action of this.actions) {
			if (action.source.kind === "member") {
				action.source.observable = o(action.source.observable);
			}
		}
		for (const access of accesses) {
			if (access.kind === "ComputedRead") access.computed = c(access.computed);
			else access.observable = o(access.observable);
			// Build a new context rather than editing in place: context objects may be shared.
			const ctx = access.context;
			if (ctx.kind === "tracked" || ctx.kind === "tracked-nested") {
				access.context = { kind: ctx.kind, by: d(ctx.by) };
			} else if (ctx.kind === "effect") {
				access.context = { kind: "effect", reaction: r(ctx.reaction) };
			} else if (ctx.kind === "action") {
				access.context = { kind: "action", action: a(ctx.action) };
			} else if (ctx.kind === "after-await") {
				access.context = {
					kind: "after-await",
					in: ctx.in.startsWith("action:")
						? a(ctx.in as ActionId)
						: d(ctx.in as DerivationId),
				};
			}
		}
		for (const diagnostic of this.diagnostics) {
			if (diagnostic.related) {
				diagnostic.related = diagnostic.related.map(
					(id) => any(id) as (typeof diagnostic.related)[number],
				);
			}
		}
	}

	private diagnose(
		code: DiagnosticCode,
		severity: Diagnostic["severity"],
		message: string,
		span: Span,
		related?: Diagnostic["related"],
	): void {
		const diagnostic: Diagnostic = {
			kind: "Diagnostic",
			code,
			severity,
			message,
			span,
		};
		if (related && related.length > 0) diagnostic.related = related;
		this.diagnostics.push(diagnostic);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProgramPath(file: t.File): NodePath<t.Program> {
	let program: NodePath<t.Program> | undefined;
	traverse(file, {
		Program(path) {
			program = path;
			path.stop();
		},
	});
	if (!program) throw new Error("sobx: could not locate Program node");
	return program;
}

/**
 * Sort `items` by `key` (stable), reassign `${prefix}:${index}` ids in place, and return a
 * map from old id to new id.
 */
function reorder<T extends { id: string }>(
	items: T[],
	prefix: string,
	key: (item: T) => number,
): Map<string, string> {
	const map = new Map<string, string>();
	items.sort((x, y) => key(x) - key(y));
	items.forEach((item, i) => {
		const id = `${prefix}:${i}`;
		map.set(item.id, id);
		item.id = id as T["id"];
	});
	return map;
}

function toKnownApi(name: string): KnownApi | null {
	if (MODELED_APIS.has(name) || UNMODELED_APIS.has(name)) {
		return name as KnownApi;
	}
	return null;
}

function sortByStart<T extends NodePath>(paths: readonly T[]): T[] {
	return [...paths].sort((a, b) => (a.node.start ?? 0) - (b.node.start ?? 0));
}

function toSpan(node: t.Node): Span {
	const loc = node.loc;
	return {
		start: node.start ?? 0,
		end: node.end ?? 0,
		loc: {
			start: {
				line: loc?.start.line ?? 0,
				column: loc?.start.column ?? 0,
			},
			end: { line: loc?.end.line ?? 0, column: loc?.end.column ?? 0 },
		},
	};
}

/** Expression wrappers that do not change the runtime value. */
function isTransparentWrapper(node: t.Node): node is t.Node & {
	expression: t.Expression;
} {
	return (
		t.isTSAsExpression(node) ||
		t.isTSSatisfiesExpression(node) ||
		t.isTSNonNullExpression(node) ||
		t.isTSTypeAssertion(node) ||
		t.isParenthesizedExpression(node)
	);
}

/** Walk up through {@link isTransparentWrapper} nodes. */
function outerExpression(path: NodePath): NodePath {
	let p = path;
	while (
		p.parentPath &&
		isTransparentWrapper(p.parentPath.node) &&
		p.parentPath.node.expression === p.node
	) {
		p = p.parentPath;
	}
	return p;
}

/** Whether `path` sits inside a TypeScript type (e.g. `typeof store` in a type annotation). */
function isInTypePosition(path: NodePath): boolean {
	for (let p = path.parentPath; p; p = p.parentPath) {
		if (t.isTSType(p.node)) return true;
		if (p.isStatement() || p.isExpression()) return false;
	}
	return false;
}

/**
 * References to `binding` in value positions, in source order. Excludes type positions and
 * the `export` declaration Babel records as a reference of exported declarations.
 */
function valueReferences(binding: BabelBinding): NodePath[] {
	return sortByStart(
		binding.referencePaths.filter(
			(ref) => !ref.isExportDeclaration() && !isInTypePosition(ref),
		),
	);
}

/** Uses that neither read properties nor leak the reference. */
function isHarmlessUse(parent: NodePath): boolean {
	return (
		parent.isExpressionStatement() ||
		(parent.isUnaryExpression() &&
			(parent.node.operator === "typeof" || parent.node.operator === "void")) ||
		(parent.isBinaryExpression() &&
			["===", "!==", "==", "!="].includes(parent.node.operator))
	);
}

function referenceName(ref: NodePath): string {
	if (t.isIdentifier(ref.node)) return ref.node.name;
	if (t.isThisExpression(ref.node)) return "this";
	return "<observable>";
}

/** Whether the binding's declaration itself is exported (`export const x = ...`). */
function isDeclaredExported(binding: BabelBinding): boolean {
	const p = binding.path;
	return (
		(p.parentPath?.isExportDeclaration() ||
			p.parentPath?.parentPath?.isExportDeclaration()) ??
		false
	);
}

function isExported(binding: BabelBinding): boolean {
	if (isDeclaredExported(binding)) return true;
	return binding.referencePaths.some(
		(ref) => ref.parentPath?.isExportSpecifier() ?? false,
	);
}

/**
 * If the value at `outer` is stored in a simple variable (`const x = <value>` or
 * `x = <value>`), return that binding.
 */
function resolveResultBinding(
	outer: NodePath,
): { binding: Binding; babel: BabelBinding } | null {
	const parent = outer.parentPath;
	let target: { name: string; kind: Binding["declarationKind"] } | null = null;

	if (
		parent?.isVariableDeclarator() &&
		parent.node.init === outer.node &&
		t.isIdentifier(parent.node.id)
	) {
		const decl = parent.parentPath;
		const kind =
			decl?.isVariableDeclaration() &&
			(decl.node.kind === "let" || decl.node.kind === "var")
				? decl.node.kind
				: "const";
		target = { name: parent.node.id.name, kind };
	} else if (
		parent?.isAssignmentExpression() &&
		parent.node.operator === "=" &&
		parent.node.right === outer.node &&
		t.isIdentifier(parent.node.left)
	) {
		target = { name: parent.node.left.name, kind: "assignment" };
	}
	if (!target) return null;

	const babel = outer.scope.getBinding(target.name);
	if (!babel) return null;
	return {
		babel,
		binding: {
			name: target.name,
			scope: babel.scope.path.isProgram() ? "module" : "local",
			declarationKind: target.kind,
			exported: isExported(babel),
		},
	};
}

/** The class whose constructor directly contains `path` (arrow functions are transparent). */
function enclosingConstructorClass(path: NodePath): NodePath<t.Class> | null {
	for (let p = path.parentPath; p; p = p.parentPath) {
		if (p.isArrowFunctionExpression()) continue;
		if (p.isFunction()) {
			if (p.isClassMethod() && p.node.kind === "constructor") {
				const cls = p.parentPath?.parentPath;
				return cls?.isClass() ? cls : null;
			}
			return null;
		}
	}
	return null;
}

function className(classPath: NodePath<t.Class>): string | null {
	if (classPath.node.id) return classPath.node.id.name;
	const parent = classPath.parentPath;
	if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
		return parent.node.id.name;
	}
	return null;
}

/**
 * The object literal or class that `this` refers to at `path`, or `null` if it is not
 * statically known (plain functions, static members, module scope).
 */
function thisOwner(path: NodePath): t.Node | null {
	for (let p = path.parentPath; p; p = p.parentPath) {
		if (p.isArrowFunctionExpression()) continue;
		if (
			p.isClassProperty() ||
			p.isClassAccessorProperty() ||
			p.isClassPrivateProperty() ||
			p.isClassMethod() ||
			p.isClassPrivateMethod()
		) {
			if (p.node.static) return null;
			return p.parentPath?.parentPath?.node ?? null;
		}
		if (p.isObjectMethod()) return p.parentPath?.node ?? null;
		if (
			p.isFunctionExpression() &&
			p.parentPath?.isObjectProperty() &&
			p.parentPath.node.value === p.node
		) {
			return p.parentPath.parentPath?.node ?? null;
		}
		if (p.isFunction() || p.isStaticBlock() || p.isClass() || p.isProgram()) {
			return null;
		}
	}
	return null;
}

function propertyKey(key: t.Node, computed: boolean): AccessKey {
	if (!computed && t.isIdentifier(key))
		return { kind: "static", name: key.name };
	if (t.isStringLiteral(key)) return { kind: "static", name: key.value };
	if (t.isNumericLiteral(key))
		return { kind: "static", name: String(key.value) };
	if (
		t.isTemplateLiteral(key) &&
		key.expressions.length === 0 &&
		key.quasis.length === 1
	) {
		return { kind: "static", name: key.quasis[0]?.value.cooked ?? "" };
	}
	return { kind: "dynamic" };
}

/** Parameter count, excluding a TypeScript `this:` parameter (not a runtime parameter). */
const COLLECTION_CONSTRUCTORS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

/** An array literal or `new Map/Set/WeakMap/WeakSet(...)`. */
function isCollection(node: t.Node): boolean {
	return (
		t.isArrayExpression(node) ||
		(t.isNewExpression(node) &&
			t.isIdentifier(node.callee) &&
			COLLECTION_CONSTRUCTORS.has(node.callee.name))
	);
}

function runtimeParamCount(params: t.Function["params"]): number {
	const first = params[0];
	return t.isIdentifier(first, { name: "this" })
		? params.length - 1
		: params.length;
}

function memberKey(
	node: t.MemberExpression | t.OptionalMemberExpression,
): AccessKey {
	if (t.isPrivateName(node.property)) return { kind: "dynamic" };
	return propertyKey(node.property, node.computed);
}

function memberAccess(
	member: NodePath,
	observable: ObservableId,
	key: AccessKey,
	receiver: Receiver,
	context: AccessContext,
): PendingAccess {
	const m = outerExpression(member);
	const parent = m.parentPath;
	const span = toSpan(member.node);
	const base = { observable, key, receiver, context, span };

	if (parent?.isAssignmentExpression() && parent.node.left === m.node) {
		const operator = parent.node.operator;
		return {
			kind: "Write",
			...base,
			operator,
			readsPrevious: operator !== "=",
		};
	}
	if (parent?.isUpdateExpression()) {
		return {
			kind: "Write",
			...base,
			operator: parent.node.operator,
			readsPrevious: true,
		};
	}
	if (parent?.isUnaryExpression() && parent.node.operator === "delete") {
		return { kind: "Delete", ...base };
	}
	if (
		((parent?.isForInStatement() || parent?.isForOfStatement()) &&
			parent.node.left === m.node) ||
		parent?.isArrayPattern() ||
		parent?.isRestElement() ||
		(parent?.isAssignmentPattern() && parent.node.left === m.node) ||
		(parent?.isObjectProperty() &&
			parent.node.value === m.node &&
			parent.parentPath?.isObjectPattern())
	) {
		return { kind: "Write", ...base, operator: "=", readsPrevious: false };
	}
	return {
		kind: "Read",
		...base,
		via: "member",
		path: readPath(m),
		called:
			(parent?.isCallExpression() || parent?.isOptionalCallExpression()) ===
				true && (parent.node as t.CallExpression).callee === m.node,
	};
}

/** Static property reads chained onto `member` (`store.user.name` -> `["name"]`). */
function readPath(member: NodePath): AccessKey[] {
	const path: AccessKey[] = [];
	let current = member;
	while (
		current.parentPath &&
		(current.parentPath.isMemberExpression() ||
			current.parentPath.isOptionalMemberExpression()) &&
		current.parentPath.node.object === current.node
	) {
		const key = memberKey(current.parentPath.node);
		path.push(key);
		if (key.kind === "dynamic") break;
		current = outerExpression(current.parentPath);
	}
	return path;
}

function accessIndex(id: AccessId): number {
	return Number(id.slice("access:".length));
}

function valueKind(node: t.Node): ValueKind {
	if (
		t.isStringLiteral(node) ||
		t.isNumericLiteral(node) ||
		t.isBooleanLiteral(node) ||
		t.isNullLiteral(node) ||
		t.isBigIntLiteral(node) ||
		(t.isTemplateLiteral(node) && node.expressions.length === 0) ||
		t.isIdentifier(node, { name: "undefined" }) ||
		(t.isUnaryExpression(node) && t.isNumericLiteral(node.argument))
	) {
		return "primitive";
	}
	if (t.isObjectExpression(node)) return "object";
	if (t.isArrayExpression(node)) return "array";
	if (t.isFunctionExpression(node) && node.generator) return "generator";
	if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
		return "function";
	}
	if (isTransparentWrapper(node)) return valueKind(node.expression);
	return "unknown";
}

/** The annotation `observable()` / `makeAutoObservable()` infer for a member. */
function inferAnnotation(
	m: RawMember,
	defaults: InferenceDefaults,
): Annotation {
	if (m.memberKind === "getter") {
		return { kind: "computed", modifier: "default" };
	}
	if (m.valueKind === "generator") {
		return { kind: "flow", bound: defaults.autoBind };
	}
	if (m.memberKind === "method" || m.valueKind === "function") {
		return { kind: "autoAction", bound: defaults.autoBind };
	}
	return { kind: "observable", modifier: defaults.deep ? "deep" : "ref" };
}

function objectMembers(
	node: t.ObjectExpression,
	kindOf: (n: t.Node | null | undefined) => ValueKind,
): { members: RawMember[]; open: boolean } {
	const members: RawMember[] = [];
	let open = false;

	for (const prop of node.properties) {
		if (t.isSpreadElement(prop)) {
			open = true;
			continue;
		}
		const key = propertyKey(prop.key, prop.computed);
		if (key.kind === "dynamic") {
			open = true;
			continue;
		}
		const base = {
			key: key.name,
			static: false,
			accessor: false,
			decorators: [],
			span: toSpan(prop),
		};
		if (t.isObjectMethod(prop)) {
			if (prop.kind === "set") continue;
			members.push({
				...base,
				memberKind: prop.kind === "get" ? "getter" : "method",
				valueKind:
					prop.kind === "get"
						? "getter"
						: prop.generator
							? "generator"
							: "function",
				value: prop,
			});
			continue;
		}
		members.push({
			...base,
			memberKind: "field",
			valueKind: kindOf(prop.value),
			value: prop.value,
		});
	}

	return { members, open };
}

function classMembers(
	node: t.Class,
	kindOf: (n: t.Node | null | undefined) => ValueKind,
): { members: RawMember[]; open: boolean } {
	const members: RawMember[] = [];
	let open = false;
	let ctor: t.ClassMethod | null = null;

	for (const el of node.body.body) {
		if (t.isClassMethod(el) && el.kind === "constructor") {
			ctor = el;
			continue;
		}
		if (
			!(
				t.isClassMethod(el) ||
				t.isClassProperty(el) ||
				t.isClassAccessorProperty(el)
			)
		) {
			continue; // private members, static blocks, index signatures
		}
		const key = propertyKey(el.key, el.computed);
		if (key.kind === "dynamic") {
			open = true;
			continue;
		}
		const base = {
			key: key.name,
			static: el.static,
			accessor: t.isClassAccessorProperty(el),
			decorators: el.decorators ?? [],
			span: toSpan(el),
		};
		if (t.isClassMethod(el)) {
			if (el.kind === "set") continue;
			members.push({
				...base,
				memberKind: el.kind === "get" ? "getter" : "method",
				valueKind:
					el.kind === "get"
						? "getter"
						: el.generator
							? "generator"
							: "function",
				value: el,
			});
			continue;
		}
		members.push({
			...base,
			memberKind: "field",
			valueKind: el.value ? kindOf(el.value) : "unknown",
			value: el.value ?? null,
		});
	}

	// Fields assigned in the constructor: `this.x = ...`.
	for (const stmt of ctor?.body.body ?? []) {
		if (!t.isExpressionStatement(stmt)) continue;
		const expr = stmt.expression;
		if (
			!t.isAssignmentExpression(expr) ||
			expr.operator !== "=" ||
			!t.isMemberExpression(expr.left) ||
			!t.isThisExpression(expr.left.object)
		) {
			continue;
		}
		const key = memberKey(expr.left);
		if (key.kind === "dynamic") {
			open = true;
			continue;
		}
		if (members.some((m) => m.key === key.name && !m.static)) continue;
		members.push({
			key: key.name,
			memberKind: "field",
			valueKind: kindOf(expr.right),
			static: false,
			accessor: false,
			value: expr.right,
			decorators: [],
			span: toSpan(expr),
		});
	}

	return { members, open };
}

function optionValue(node: t.Node): OptionValue {
	if (
		t.isStringLiteral(node) ||
		t.isNumericLiteral(node) ||
		t.isBooleanLiteral(node)
	) {
		return { kind: "literal", value: node.value };
	}
	if (t.isNullLiteral(node)) return { kind: "literal", value: null };
	return { kind: "unknown" };
}

function optionsArgument(call: NodePath<t.CallExpression>): Options | null {
	const arg = call.node.arguments[2];
	return arg ? optionsOf(arg) : null;
}

function optionsOf(node: t.Node): Options {
	if (!t.isObjectExpression(node))
		return { kind: "unknown", span: toSpan(node) };
	const entries: Record<string, OptionValue> = {};
	let open = false;
	for (const prop of node.properties) {
		if (t.isSpreadElement(prop)) {
			open = true;
			continue;
		}
		const key = propertyKey(prop.key, prop.computed);
		if (key.kind === "dynamic") {
			open = true;
			continue;
		}
		entries[key.name] = t.isObjectMethod(prop)
			? { kind: "unknown" }
			: optionValue(prop.value);
	}
	return { kind: "object", entries, open };
}

function describeEscape(parent: NodePath, ref: NodePath): string {
	if (parent.isCallExpression() || parent.isNewExpression()) {
		return "passed as an argument";
	}
	if (parent.isReturnStatement() || parent.isArrowFunctionExpression()) {
		return "returned";
	}
	if (parent.isExportSpecifier()) return "exported";
	if (parent.isExportDefaultDeclaration()) return "exported";
	if (parent.isSpreadElement()) return "spread";
	if (parent.isClass() && parent.node.superClass === ref.node) {
		return "subclassed";
	}
	if (parent.isVariableDeclarator() || parent.isAssignmentExpression()) {
		return "aliased";
	}
	if (parent.isArrayExpression() || parent.isObjectProperty()) {
		return "stored in another value";
	}
	if (parent.isForOfStatement() && parent.node.right === ref.node) {
		return "iterated";
	}
	return `used in ${parent.node.type}`;
}
