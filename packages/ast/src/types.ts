/**
 * sobx's intermediate representation (IR) of a program's MobX-style usages.
 *
 * Design rules:
 * - **Plain data.** Every value here is JSON-serializable: string kinds, numeric spans,
 *   and cross-references by stable string id. No parser (Babel / TypeScript) nodes leak
 *   into the IR, so any front-end can produce it and any back-end can consume it.
 * - **Sound or loud.** Anything the analyzer cannot model precisely is surfaced as a
 *   {@link Diagnostic} rather than silently dropped.
 */

/** Version of the IR shape. Bump on breaking changes to these types. */
export const IR_VERSION = 5;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A 1-based line / 0-based column position. */
export interface Position {
	line: number;
	column: number;
}

/** Source range of a construct. `start` / `end` are character offsets into the module source. */
export interface Span {
	start: number;
	end: number;
	loc: { start: Position; end: Position };
}

// Ids are assigned in source order (by the entity's span) within each kind.

/** Id of an {@link Observable} within its module, e.g. `"observable:0"`. */
export type ObservableId = `observable:${number}`;
/** Id of a {@link Computed} within its module, e.g. `"computed:0"`. */
export type ComputedId = `computed:${number}`;
/** Id of a {@link Reaction} within its module, e.g. `"reaction:0"`. */
export type ReactionId = `reaction:${number}`;
/** Id of an {@link Action} within its module, e.g. `"action:0"`. */
export type ActionId = `action:${number}`;
/** Id of an {@link Access} within its module, e.g. `"access:0"`. */
export type AccessId = `access:${number}`;

/** Something that tracks the observables it reads. */
export type DerivationId = ReactionId | ComputedId;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** The IR for a single source module (file). */
export interface SobxModule {
	kind: "Module";
	irVersion: typeof IR_VERSION;
	/** Filename, if one was provided to the analyzer. */
	filename: string | null;
	/** Module specifier treated as the MobX-compatible API (e.g. `"@sobx/magic"` or `"mobx"`). */
	moduleSpecifier: string;
	imports: SobxImport[];
	observables: Observable[];
	computeds: Computed[];
	accesses: Access[];
	reactions: Reaction[];
	actions: Action[];
	/** API usages that were recognized but are not (yet) modeled. */
	unsupported: UnsupportedUsage[];
	diagnostics: Diagnostic[];
	/**
	 * Property operations that only a `Proxy` would observe, on values whose origin can't be
	 * traced (parameters, imports, call results...), which may be observables.
	 */
	untracedOperations: UntracedOperation[];
}

/**
 * A property operation that only a `Proxy` would observe (a dynamic key, an array index or
 * `length`, a write, `delete`, `in`, `Object.keys` / `values` / `entries`) on a value whose
 * origin the analyzer can't trace, so it may be an observable.
 */
export interface UntracedOperation {
	/**
	 * `read` / `write` / `delete`: of the member at `span`. `in` / `enumerate`: the expression at
	 * `span`. `keys`: the object spread / JSX spread attribute / `for...in` at `span` enumerates
	 * its value's keys. Calls at `span`: `assign` (`Object.assign`), `keys-arg`
	 * (`Object.getOwnPropertyNames` / `getOwnPropertySymbols`, `Reflect.ownKeys`), `deep-arg`
	 * (`JSON.stringify`, `structuredClone`: everything reachable from the first argument),
	 * `has-own` (`Object.hasOwn`, `o.hasOwnProperty(k)`, `Object.prototype.hasOwnProperty.call`).
	 */
	kind:
		| "read"
		| "write"
		| "delete"
		| "in"
		| "enumerate"
		| "keys"
		| "assign"
		| "keys-arg"
		| "deep-arg"
		| "has-own";
	key: AccessKey;
	/** Offsets only (no line / column). */
	span: Pick<Span, "start" | "end">;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** APIs sobx models in the IR. */
export type ModeledApi =
	| "action"
	| "autorun"
	| "computed"
	| "flow"
	| "makeAutoObservable"
	| "makeObservable"
	| "observable"
	| "reaction"
	| "runInAction"
	| "when";

/**
 * MobX APIs that are recognized but not modeled. Usages are reported as {@link UnsupportedUsage}.
 * (None at the moment.)
 */
export type UnmodeledApi = never;

/** Recognized exports that are used as values or utilities and not analyzed (e.g. `comparer.structural`, `toJS(x)`). */
export type ValueApi =
	| "comparer"
	| "configure"
	| "entries"
	| "get"
	| "has"
	| "isAction"
	| "isBoxedObservable"
	| "isComputed"
	| "isFlowCancellationError"
	| "isObservable"
	| "isObservableArray"
	| "isObservableMap"
	| "isObservableObject"
	| "isObservableSet"
	| "keys"
	| "remove"
	| "set"
	| "toJS"
	| "untracked"
	| "values";

export type KnownApi = ModeledApi | UnmodeledApi | ValueApi;

/** A single binding introduced by an import from the configured module specifier. */
export type SobxImport =
	| {
			kind: "NamedImport";
			/** The exported name (`imported` in `import { imported as local }`). */
			imported: string;
			local: string;
			/** Which API this resolves to, or `null` if the name is not a known API. */
			api: KnownApi | null;
			span: Span;
	  }
	| {
			kind: "NamespaceImport";
			local: string;
			span: Span;
	  }
	| {
			kind: "DefaultImport";
			local: string;
			span: Span;
	  };

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------

/** Where a value is bound. */
export interface Binding {
	name: string;
	/** `"module"` for top-level bindings, `"local"` for anything nested in a function/block. */
	scope: "module" | "local";
	declarationKind: "const" | "let" | "var" | "assignment";
	/** Whether the binding is exported from the module. */
	exported: boolean;
}

/** Rough classification of a value. */
export type ValueKind =
	| "primitive"
	| "object"
	| "array"
	| "function"
	| "generator"
	| "getter"
	| "unknown";

/**
 * A MobX annotation, as written explicitly (annotations object, overrides object, decorator)
 * or as inferred by `observable()` / `makeAutoObservable()`.
 */
export type Annotation =
	| { kind: "observable"; modifier: "deep" | "ref" | "shallow" | "struct" }
	| { kind: "computed"; modifier: "default" | "struct" }
	| { kind: "action"; bound: boolean }
	/** Inferred for functions by `observable()` / `makeAutoObservable()`. `bound` reflects `autoBind`. */
	| { kind: "autoAction"; bound: boolean }
	| { kind: "flow"; bound: boolean }
	/** Explicitly excluded with `false`. */
	| { kind: "excluded" }
	/** An annotation expression that could not be resolved. */
	| { kind: "unknown" };

/** A property of an object observable, or a member of an observable class. */
export interface ObservableMember {
	key: string;
	/**
	 * - `field`: a data property / class field (including function-valued ones).
	 * - `getter`: a `get` accessor.
	 * - `method`: an object or class method.
	 */
	memberKind: "field" | "getter" | "method";
	valueKind: ValueKind;
	static: boolean;
	/** Whether the member is an auto-accessor (`accessor x = 0`). */
	accessor: boolean;
	/** Effective annotation, or `null` if the member is not made observable. */
	annotation: Annotation | null;
	/** Where {@link ObservableMember.annotation} came from. `null` when there is no annotation. */
	annotationSource: "explicit" | "decorator" | "inferred" | null;
	/** The computed backing a `computed`-annotated getter. */
	computed: ComputedId | null;
	/** The action backing an `action` / `autoAction`-annotated function. */
	action: ActionId | null;
	span: Span;
}

/** The statically-known shape of an observable. */
export type ObservableShape =
	| {
			kind: "object";
			members: ObservableMember[];
			/** True when the literal/class has spreads or computed keys, so `members` is incomplete. */
			open: boolean;
	  }
	/** `observable([...])` / `observable.array()`, `observable.box(v)`, `observable.map()` / `observable(new Map())`, `observable.set()` / `observable(new Set())`. Their reads and writes are tracked by the runtime, not analyzed. */
	| { kind: "array" }
	| { kind: "box" }
	| { kind: "map" }
	| { kind: "set" }
	| { kind: "unknown" };

/**
 * What made something observable: one of the APIs, or (for classes) standard decorators
 * alone, with no `makeObservable(this)` call.
 */
export type ObservableSource =
	| "observable"
	| "makeObservable"
	| "makeAutoObservable"
	| "decorators"
	/** `@sobx/react`'s hooks (a runtime observable made from the initializer's result). */
	| "useLocalObservable"
	| "useLocalStore";

interface ObservableBase {
	kind: "Observable";
	id: ObservableId;
	source: ObservableSource;
	shape: ObservableShape;
	/**
	 * The options argument (`{ deep, autoBind, name, proxy }`), if any. `deep` and `autoBind`
	 * are already applied to inferred member annotations.
	 */
	options: Options | null;
	/** Span of the creating call, or of the class for decorator-only classes. */
	span: Span;
}

/** An observable object: `observable({...})` or `makeAutoObservable({...})`. */
export interface ObjectObservable extends ObservableBase {
	target: "object";
	/** The binding the observable is stored in, or `null` if it is not bound to a simple identifier. */
	binding: Binding | null;
}

/**
 * A class made observable by `makeObservable(this, ...)` / `makeAutoObservable(this)` in its
 * constructor, or by standard (2022.3) decorators alone.
 */
export interface ClassObservable extends ObservableBase {
	target: "class";
	className: string | null;
	/** Whether the class is exported (instances created elsewhere are not tracked). */
	exported: boolean;
	/** Bindings holding instances created in this module (`const s = new Store()`). */
	instances: Binding[];
	classSpan: Span;
}

export type Observable = ObjectObservable | ClassObservable;

// ---------------------------------------------------------------------------
// Computeds
// ---------------------------------------------------------------------------

export type ComputedSource =
	/** `const c = computed(() => ...)`. Read with `c.get()`. */
	| { kind: "call"; binding: Binding | null }
	/** A getter on an observable object or class. Read as a property. */
	| { kind: "getter"; observable: ObservableId; key: string };

export interface Computed {
	kind: "Computed";
	id: ComputedId;
	source: ComputedSource;
	body: FunctionRef;
	options: Options | null;
	/** Reads (by id) that occur directly in the body. */
	dependencies: AccessId[];
	/** Reads in functions the body calls (transitively); see {@link DataEffectReaction}. */
	indirectDependencies: AccessId[];
	span: Span;
}

// ---------------------------------------------------------------------------
// Accesses
// ---------------------------------------------------------------------------

/** The property key of an access. */
export type AccessKey =
	| { kind: "static"; name: string }
	/** A computed key whose value is not statically known (e.g. `store[k]`). */
	| { kind: "dynamic" };

/** Which tracking context an access occurs in. */
export type AccessContext =
	| { kind: "untracked" }
	/** Directly inside a tracked function (reaction data fn, autorun body, computed body). */
	| { kind: "tracked"; by: DerivationId }
	/**
	 * Inside a function *defined within* a tracked function. Whether it runs during tracking
	 * is not statically known.
	 */
	| { kind: "tracked-nested"; by: DerivationId }
	/** Inside a reaction's effect function (including nested functions). Not tracked. */
	| { kind: "effect"; reaction: ReactionId }
	/** Directly inside an action body. */
	| { kind: "action"; action: ActionId }
	/**
	 * Inside an async action or tracked function, after an `await` (or in a loop containing
	 * one). This code runs outside the action / tracking.
	 */
	| { kind: "after-await"; in: ActionId | DerivationId };

interface PropertyAccessBase {
	id: AccessId;
	observable: ObservableId;
	key: AccessKey;
	/** Whether the observable was referenced through a binding (`store.x`) or `this` (`this.x`). */
	receiver: "binding" | "this";
	context: AccessContext;
	span: Span;
}

export interface ReadAccess extends PropertyAccessBase {
	kind: "Read";
	/** How the read was expressed. */
	via: "member" | "destructure";
	/**
	 * Further static property reads on the value, e.g. `["name"]` for `store.user.name`.
	 * Stops at the first call or dynamic key (recorded as `{ kind: "dynamic" }`).
	 */
	path: AccessKey[];
	/** Whether the read value is called (`store.method()`). */
	called: boolean;
}

export interface WriteAccess extends PropertyAccessBase {
	kind: "Write";
	/** `"="`, `"+="`, ..., or `"++"` / `"--"` for update expressions. */
	operator: string;
	/** Whether the write also reads the previous value (compound assignment or update). */
	readsPrevious: boolean;
}

export interface DeleteAccess extends PropertyAccessBase {
	kind: "Delete";
}

/** `c.get()` on a boxed `computed(...)`. */
export interface ComputedReadAccess {
	kind: "ComputedRead";
	id: AccessId;
	computed: ComputedId;
	context: AccessContext;
	span: Span;
}

export type PropertyAccess = ReadAccess | WriteAccess | DeleteAccess;
export type Access = PropertyAccess | ComputedReadAccess;

// ---------------------------------------------------------------------------
// Reactions & actions
// ---------------------------------------------------------------------------

/** A function argument or member. */
export type FunctionRef =
	| {
			kind: "inline";
			/** Number of declared parameters. */
			params: number;
			async: boolean;
			span: Span;
	  }
	/** Not an inline function (e.g. an identifier or call result); its body is not analyzed. */
	| { kind: "opaque"; span: Span };

export type OptionValue =
	| { kind: "literal"; value: string | number | boolean | null }
	| { kind: "unknown" };

/** An options object argument. */
export type Options =
	| {
			kind: "object";
			entries: Record<string, OptionValue>;
			/** True when the object has spreads or computed keys. */
			open: boolean;
	  }
	| { kind: "unknown"; span: Span };

interface ReactionBase {
	kind: "Reaction";
	id: ReactionId;
	options: Options | null;
	/** Reads (by id) that occur directly in the tracked function. */
	dependencies: AccessId[];
	/**
	 * Reads (by id) inside functions the tracked function calls, transitively: local functions
	 * and methods of observables. These run during tracking, so they are dependencies too.
	 * Functions annotated `action` are not followed (actions run untracked).
	 */
	indirectDependencies: AccessId[];
	/** Whether the returned disposer is used (stored, returned, or passed along). */
	disposerUsed: boolean;
	span: Span;
}

/** `reaction(data, effect, options?)`. */
export interface DataEffectReaction extends ReactionBase {
	api: "reaction";
	/** The data function whose reads are tracked. */
	data: FunctionRef;
	/** The effect run when the tracked value changes. */
	effect: FunctionRef;
}

/** `autorun(body, options?)`. The body is both tracked and the effect. */
export interface AutorunReaction extends ReactionBase {
	api: "autorun";
	body: FunctionRef;
}

/**
 * `when(predicate, effect, options?)`, or `when(predicate, options?)` (returns a promise, so
 * there is no effect).
 */
export interface WhenReaction extends ReactionBase {
	api: "when";
	/** Tracked until it returns true. */
	predicate: FunctionRef;
	/** Run once the predicate is true (absent in the promise form). */
	effect?: FunctionRef;
}

export type Reaction = DataEffectReaction | AutorunReaction | WhenReaction;

export type ActionSource =
	/** `runInAction(fn)`: runs once, immediately. */
	| { kind: "runInAction" }
	/** `action(fn)` / `action(name, fn)`: wraps a function that runs whenever called. */
	| { kind: "action"; name: string | null; binding: Binding | null }
	/** `flow(function* () {...})`: each step between `yield`s runs as an action. */
	| { kind: "flow"; binding: Binding | null }
	/** A member annotated `action` / `autoAction` / `flow` on an observable object or class. */
	| {
			kind: "member";
			observable: ObservableId;
			key: string;
			annotation: "action" | "autoAction" | "flow";
			bound: boolean;
	  };

export interface Action {
	kind: "Action";
	id: ActionId;
	source: ActionSource;
	body: FunctionRef;
	/** Writes / deletes (by id) that occur directly in the action body. */
	writes: AccessId[];
	span: Span;
}

export interface UnsupportedUsage {
	kind: "UnsupportedUsage";
	api: UnmodeledApi | null;
	/** The local name that was used. */
	local: string;
	span: Span;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticCode =
	/** `import * as m from "@sobx/magic"`. */
	| "namespace-import"
	/** `import m from "@sobx/magic"`. */
	| "default-import"
	/** Imported a name that is not a known API. */
	| "unknown-import"
	/** Used a recognized-but-unmodeled API (or API member such as `observable.box`). */
	| "unsupported-api"
	/** An API binding used other than as a direct call or annotation. */
	| "api-not-called"
	/** An API was called with missing / malformed arguments. */
	| "invalid-arguments"
	/** An observable array, box, Map or Set: tracked by the runtime, its reads and writes are not analyzed. */
	| "opaque-observable"
	/** `observable(...)` / `computed(...)` result not bound to a simple identifier. */
	| "unbound-observable"
	/** An observable (or class, instance, computed) reference escapes analysis. */
	| "observable-escape"
	/** A property access with a non-static key. */
	| "dynamic-key"
	/** An operation on an observable that is not modeled (`in`, `Object.keys`, ...). */
	| "unsupported-operation"
	/** A function argument that is not an inline function. */
	| "opaque-function"
	/** An observable binding is reassigned after creation. */
	| "observable-reassigned"
	/** An access inside a function nested in a tracked function (may not run during tracking). */
	| "untracked-nested-read"
	/** A mutation through the value of an `observable.ref` / `observable.struct` property (not observable). */
	| "deep-mutation"
	/** A write inside a tracked function (computed / reaction data / autorun). */
	| "write-in-derivation"
	/** `makeObservable` / `makeAutoObservable` target that is neither `this` nor an object literal. */
	| "unsupported-target"
	/** `makeObservable(this)` / `makeAutoObservable(this)` outside a class constructor. */
	| "make-observable-outside-constructor"
	/** An annotation whose key does not match any member. */
	| "unknown-annotation-key"
	/** An annotation that does not fit the member it is applied to. */
	| "invalid-annotation"
	/** `makeObservable(this)` without an annotations object or decorators. */
	| "missing-annotations"
	/** An access after `await` in an async action / tracked function (runs outside it). */
	| "after-await"
	/**
	 * A tracked function uses an import from another module; whether it is observable cannot
	 * be determined per module.
	 */
	| "unresolved-import";

export interface Diagnostic {
	kind: "Diagnostic";
	code: DiagnosticCode;
	severity: "error" | "warning" | "info";
	message: string;
	span: Span;
	/** Related IR entities, if any. */
	related?: Array<ObservableId | ComputedId | ReactionId | ActionId | AccessId>;
}
