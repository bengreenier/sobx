import * as t from "@babel/types";
import type { ObservableId, SobxModule, Span } from "@sobx/ast";

export const RUNTIME_MODULE = "@sobx/runtime";

/** A local `observable({...})` compiled to a `ProxyLike`. */
export interface ProxyObservable {
	id: ObservableId;
	/** Getter keys (run with the `ProxyLike` as `this`). */
	getters: string[];
	/** Function keys wrapped as actions. */
	actions: string[];
}

/** The key of a property operation: a static name, or the member's computed expression. */
export type KeyRef = { name: string } | { dynamic: true };

/**
 * What to rewrite in a module, keyed by source span (`"start:end"`), derived from the analyzer's
 * IR (and checked against the AST by {@link finalizePlan}).
 *
 * Imports from the API module are redirected to `@sobx/runtime`, which implements the API. On
 * top of that, local `observable({...})` objects whose every use can be rewritten are compiled
 * to a `ProxyLike` with explicit `get` / `set` calls (the fast path). Every other observable is
 * left to the runtime.
 *
 * sobx never uses `Proxy`, so property operations the runtime can't observe by itself (keys
 * that aren't declared, dynamic keys, `delete`, `in`, `Object.keys`, array index / `length`
 * writes, writes through nested values) are rewritten to runtime helpers (`getProperty`,
 * `setProperty`, `hasProperty`, `keysOf`, ...).
 */
export interface CompilePlan {
	moduleSpecifier: string;
	/** Local name for the injected `ProxyLike` import. */
	proxyName: string;
	/** `observable(...)` calls compiled to `new ProxyLike(...)`, by call span. */
	proxies: Map<string, ProxyObservable>;
	/** Member reads (`s.key`, `s?.key`, `this.key`) -> `.get("key")`, by member span. */
	reads: Map<string, string>;
	/** Called member reads (`s.m()`) -> `s.get("m").call(s)`, by member span. */
	calls: Set<string>;
	/** Writes (`=`, compound, `++` / `--`), by target member span. */
	writes: Map<string, string>;
	/** `delete s.key`, by member span. */
	deletes: Map<string, string>;
	/** Destructured reads (`const { key } = s`), by pattern property span. */
	destructures: Map<string, string>;
	/** Which observable each planned span belongs to. */
	owners: Map<string, ObservableId>;
	/** Observables left to the runtime, and why. */
	fallbacks: Map<ObservableId, string>;
	/** Runtime (accessor-based) object observables and observable arrays. */
	runtimeTargets: Set<ObservableId>;
	/** Reads of runtime targets that need `getProperty` (undeclared / dynamic keys, array index / `length`), by member span. */
	propertyReads: Map<string, KeyRef>;
	/** Writes of runtime targets that need `setProperty` / `updateProperty`, by target member span. */
	propertyWrites: Map<string, KeyRef>;
	/** `delete` of runtime targets' properties (`deleteProperty`), by member span. */
	propertyDeletes: Map<string, KeyRef>;
	/** `k in target` / `Object.keys(target)` (and `values` / `entries`) on runtime targets, by expression span. */
	operations: Set<string>;
	/** Reads of an observable's property that continue into a nested value (`store.items[0]`), by member span. */
	pathBases: Set<string>;
	/**
	 * Spans of operations on values whose origin can't be traced (they may be observables):
	 * rewritten when that preserves their semantics, and otherwise left as they are, silently.
	 */
	untraced: Set<string>;
	/** Spans the final rewrite handled (set by {@link finalizePlan}). */
	rewritten: Set<string>;
	/** Writes that would not be observed and couldn't be rewritten (set by {@link finalizePlan}). */
	uncompiled: Array<{ span: Span; message: string }>;
}

export function spanKey(span: { start?: number | null; end?: number | null }) {
	return `${span.start}:${span.end}`;
}

export function emptyPlan(moduleSpecifier: string): CompilePlan {
	return {
		moduleSpecifier,
		proxyName: "ProxyLike",
		proxies: new Map(),
		reads: new Map(),
		calls: new Set(),
		writes: new Map(),
		deletes: new Map(),
		destructures: new Map(),
		owners: new Map(),
		fallbacks: new Map(),
		runtimeTargets: new Set(),
		propertyReads: new Map(),
		propertyWrites: new Map(),
		propertyDeletes: new Map(),
		operations: new Set(),
		pathBases: new Set(),
		untraced: new Set(),
		rewritten: new Set(),
		uncompiled: [],
	};
}

/** Diagnostics that mean some use of the observable can't be rewritten to `get` / `set`. */
const FALLBACK_CODES = new Set([
	"observable-escape",
	"dynamic-key",
	"unsupported-operation",
	"observable-reassigned",
]);

/**
 * Build a plan from a module's IR. Observables in `forced` (or that can't use the fast path)
 * are left to the runtime.
 */
export function planFromModule(
	mod: SobxModule,
	source: string,
	forced: Map<ObservableId, string> = new Map(),
): CompilePlan {
	const plan = emptyPlan(mod.moduleSpecifier);
	plan.proxyName = /\bProxyLike\b/.test(source)
		? "__sobx_ProxyLike"
		: "ProxyLike";
	for (const [id, reason] of forced) plan.fallbacks.set(id, reason);

	for (const d of mod.diagnostics) {
		if (!FALLBACK_CODES.has(d.code)) continue;
		for (const id of d.related ?? []) {
			if (
				id.startsWith("observable:") &&
				!plan.fallbacks.has(id as ObservableId)
			) {
				plan.fallbacks.set(id as ObservableId, `${d.code}: ${d.message}`);
			}
		}
	}

	for (const o of mod.observables) {
		if (plan.fallbacks.has(o.id)) continue;
		const reason = fastPathBlocker(o);
		if (reason) {
			plan.fallbacks.set(o.id, reason);
			continue;
		}
		if (o.shape.kind !== "object") continue;
		plan.proxies.set(spanKey(o.span), {
			id: o.id,
			getters: o.shape.members
				.filter((m) => m.memberKind === "getter")
				.map((m) => m.key),
			actions: o.shape.members
				.filter(
					(m) =>
						m.annotation?.kind === "action" ||
						m.annotation?.kind === "autoAction",
				)
				.map((m) => m.key),
		});
		plan.owners.set(spanKey(o.span), o.id);
	}

	const compiled = new Set([...plan.proxies.values()].map((p) => p.id));
	for (const a of mod.accesses) {
		if (a.kind === "ComputedRead" || !compiled.has(a.observable)) continue;
		const key = spanKey(a.span);
		if (a.key.kind !== "static") {
			plan.fallbacks.set(a.observable, "dynamic key");
			continue;
		}
		plan.owners.set(key, a.observable);
		if (a.kind === "Read" && a.via === "destructure") {
			plan.destructures.set(key, a.key.name);
		} else if (a.kind === "Read") {
			plan.reads.set(key, a.key.name);
			if (a.called) plan.calls.add(key);
		} else if (a.kind === "Write") {
			plan.writes.set(key, a.key.name);
		} else {
			plan.deletes.set(key, a.key.name);
		}
	}

	// Drop everything planned for observables that ended up falling back.
	if (plan.fallbacks.size > 0) {
		for (const [key, id] of plan.owners) {
			if (!plan.fallbacks.has(id)) continue;
			plan.owners.delete(key);
			plan.proxies.delete(key);
			plan.reads.delete(key);
			plan.calls.delete(key);
			plan.writes.delete(key);
			plan.deletes.delete(key);
			plan.destructures.delete(key);
		}
	}
	planPropertyOperations(mod, plan);
	planUntracedOperations(mod, plan);
	return plan;
}

/**
 * Plan the helper rewrites for property operations that wouldn't be observed without a `Proxy`:
 * on runtime (accessor-based) object observables and observable arrays, and writes through
 * nested values of any observable.
 */
function planPropertyOperations(mod: SobxModule, plan: CompilePlan): void {
	const compiled = new Set([...plan.proxies.values()].map((p) => p.id));
	/** Declared keys of runtime objects (`null`: not known, e.g. spreads or `observable(value)`). */
	const declared = new Map<ObservableId, Set<string> | null>();
	const arrays = new Set<ObservableId>();
	for (const o of mod.observables) {
		if (o.target !== "object" || compiled.has(o.id)) continue;
		if (o.shape.kind === "array") {
			arrays.add(o.id);
			plan.runtimeTargets.add(o.id);
		} else if (o.shape.kind === "object") {
			plan.runtimeTargets.add(o.id);
			declared.set(
				o.id,
				o.shape.open
					? null
					: new Set(o.shape.members.filter((m) => !m.static).map((m) => m.key)),
			);
		} else if (o.shape.kind === "unknown") {
			plan.runtimeTargets.add(o.id);
			declared.set(o.id, null);
		}
	}

	for (const a of mod.accesses) {
		if (a.kind === "ComputedRead") continue;
		const span = spanKey(a.span);
		if (a.kind === "Read" && a.via === "member" && a.path.length > 0) {
			plan.pathBases.add(span);
		}
		if (!plan.runtimeTargets.has(a.observable)) continue;
		const key: KeyRef =
			a.key.kind === "static" ? { name: a.key.name } : { dynamic: true };
		const isArray = arrays.has(a.observable);
		const keys = declared.get(a.observable);
		/** Whether plain property access on this key would not be observed. */
		const unobserved =
			a.key.kind !== "static" ||
			(isArray
				? a.key.name === "length" || isIndexName(a.key.name)
				: keys == null || !keys.has(a.key.name));
		if (a.kind === "Read") {
			if (a.via === "member" && !a.called && unobserved) {
				plan.propertyReads.set(span, key);
			}
		} else if (a.kind === "Write") {
			if (unobserved || isArray) plan.propertyWrites.set(span, key);
		} else {
			plan.propertyDeletes.set(span, key);
		}
	}

	for (const d of mod.diagnostics) {
		if (d.code !== "unsupported-operation") continue;
		if (
			(d.related ?? []).some((id) =>
				plan.runtimeTargets.has(id as ObservableId),
			)
		) {
			plan.operations.add(spanKey(d.span));
		}
	}
}

/**
 * Operations on values that may be observables the analyzer can't see (props, context, imports,
 * parameters...): the same helpers, which behave as plain JavaScript on other values.
 */
function planUntracedOperations(mod: SobxModule, plan: CompilePlan): void {
	for (const op of mod.untracedOperations) {
		const span = spanKey(op.span);
		const key: KeyRef =
			op.key.kind === "static" ? { name: op.key.name } : { dynamic: true };
		const target =
			op.kind === "read"
				? plan.propertyReads
				: op.kind === "write"
					? plan.propertyWrites
					: op.kind === "delete"
						? plan.propertyDeletes
						: undefined;
		if (target) {
			if (target.has(span)) continue;
			target.set(span, key);
		} else {
			if (plan.operations.has(span)) continue;
			plan.operations.add(span);
		}
		plan.untraced.add(span);
	}
}

function isIndexName(name: string): boolean {
	return /^(0|[1-9]\d*)$/.test(name);
}

/** Why an observable can't use the `ProxyLike` fast path, if it can't. */
function fastPathBlocker(o: SobxModule["observables"][number]): string | null {
	if (o.target !== "object") return "class (made observable at runtime)";
	if (o.source !== "observable")
		return `${o.source}() (made observable at runtime)`;
	if (!o.binding) return "not stored in a variable";
	if (o.shape.kind !== "object") return "not an object literal";
	if (o.options) return "has options";
	for (const m of o.shape.members) {
		const a = m.annotation;
		if (m.annotationSource === "explicit") return "has annotation overrides";
		if (!a) continue;
		// ProxyLike values are deep (Maps / Sets become observable) and compared with Object.is.
		if (a.kind === "observable" && a.modifier !== "deep") {
			return `"${m.key}" is observable.${a.modifier}`;
		}
		if ((a.kind === "action" || a.kind === "autoAction") && a.bound) {
			return `"${m.key}" is bound`;
		}
		if (a.kind === "flow" || a.kind === "unknown" || a.kind === "excluded") {
			return `"${m.key}" is ${a.kind}`;
		}
	}
	return null;
}

/** Mutable state collected while rewriting. */
export interface RewriteState {
	needsProxyLike: boolean;
	/** Runtime helpers used (imported as `__sobx_<name>`). */
	helpers: Set<string>;
	/** Planned spans that were rewritten. */
	consumed: Set<string>;
	/** Observables whose literal turned out not to fit the fast path. */
	failed: Map<ObservableId, string>;
	/** Writes that would not be observed and couldn't be rewritten. */
	uncompiled: Array<{ span: Span; message: string }>;
	/**
	 * How tracking reads (`getProperty`, `hasProperty`, `keysOf`...) are emitted: `normal`, as
	 * `tracking ? <helpers> : <plain>`; `tracked`, as helpers (inside the first branch);
	 * `plain`, as the original operations (inside the second).
	 */
	mode: "normal" | "tracked" | "plain";
	/** A write being emitted as the original operation (the plain branch of {@link markedWrite}). */
	plainWrite: t.Node | null;
	/** A read being emitted as the original operation (the plain branch of {@link trackingRead}). */
	plainRead: t.Node | null;
}

export function newRewriteState(): RewriteState {
	return {
		needsProxyLike: false,
		helpers: new Set(),
		consumed: new Set(),
		failed: new Map(),
		uncompiled: [],
		mode: "normal",
		plainWrite: null,
		plainRead: null,
	};
}

/**
 * A write rewritten to a helper (`setProperty`, `updateProperty`, `deleteProperty`) only needs
 * the helper when its object is observable: when the object can be evaluated twice, emit
 * `o[$sobx] !== void 0 ? <helper> : <original write>` (the runtime marks observables with
 * `$sobx`), so writes to plain values run as they are.
 */
function markedWrite(
	node: t.Node,
	member: t.MemberExpression,
	helperWrite: t.Node,
	plan: CompilePlan,
	state: RewriteState,
): t.Node {
	if (!isPure(member.object)) return helperWrite;
	state.helpers.add("$sobx");
	// Rewritten from the original node (the plan matches source positions), then copied.
	const object = t.cloneNode(
		rewrite(member.object, plan, state) as t.Expression,
	);
	const test = t.binaryExpression(
		"!==",
		t.memberExpression(object, t.identifier(helperName("$sobx")), true),
		t.unaryExpression("void", t.numericLiteral(0)),
	);
	const outer = state.plainWrite;
	state.plainWrite = node;
	try {
		const plain = rewrite(node, plan, state) as t.Expression;
		return t.conditionalExpression(test, helperWrite as t.Expression, plain);
	} finally {
		state.plainWrite = outer;
	}
}

function withMode<T>(
	state: RewriteState,
	mode: RewriteState["mode"],
	fn: () => T,
): T {
	const outer = state.mode;
	state.mode = mode;
	try {
		return fn();
	} finally {
		state.mode = outer;
	}
}

/**
 * A read that only needs a helper to be tracked: `getProperty(o, k)` is `o[k]`, plus tracking.
 * Tracking only matters while a derivation runs, so it's emitted as
 * `__sobx_globalState.tracking !== null ? <helpers> : <original>` (each branch evaluates the
 * operands once), and plain code outside reactions, computeds and observer renders runs at full
 * speed. Nested tracking reads take the same branch.
 */
function trackingRead(
	node: t.Node,
	target: t.Node,
	plan: CompilePlan,
	state: RewriteState,
	tracked: () => t.Expression,
): t.Expression {
	// `items`, `props.items`, `this.rows`: check the observable mark inline, as writes do, so
	// plain values skip the helper inside derivations too. (Only for such simple objects, so the
	// object isn't duplicated with conditionals of its own.)
	if (isSimpleObject(target)) {
		state.helpers.add("$sobx");
		const object = t.cloneNode(rewrite(target, plan, state) as t.Expression);
		const test = t.binaryExpression(
			"!==",
			t.memberExpression(object, t.identifier(helperName("$sobx")), true),
			t.unaryExpression("void", t.numericLiteral(0)),
		);
		const helpers = tracked();
		const outer = state.plainRead;
		state.plainRead = node;
		try {
			const plain = rewrite(node, plan, state) as t.Expression;
			return t.conditionalExpression(test, helpers, plain);
		} finally {
			state.plainRead = outer;
		}
	}
	if (state.mode === "tracked") return tracked();
	state.helpers.add("globalState");
	const test = t.binaryExpression(
		"!==",
		t.memberExpression(
			t.identifier(helperName("globalState")),
			t.identifier("tracking"),
		),
		t.nullLiteral(),
	);
	const helpers = withMode(state, "tracked", tracked);
	const plain = withMode(
		state,
		"plain",
		() => rewrite(node, plan, state) as t.Expression,
	);
	return t.conditionalExpression(test, helpers, plain);
}

/** A name, `this`, or a chain of static property reads of one (`props.items`), but not `x.length`. */
function isSimpleObject(node: t.Node): boolean {
	if (t.isIdentifier(node) || t.isThisExpression(node)) return true;
	return (
		t.isMemberExpression(node) &&
		!node.computed &&
		t.isIdentifier(node.property) &&
		node.property.name !== "length" &&
		isSimpleObject(node.object)
	);
}

/** Local name of an injected runtime helper. */
export const helperName = (name: string) => `__sobx_${name}`;

function helper(state: RewriteState, name: string, args: t.Expression[]) {
	state.helpers.add(name);
	return t.callExpression(t.identifier(helperName(name)), args);
}

/** A Babel node's location, as an IR span. */
function irSpan(node: t.Node): Span {
	const start = node.loc?.start ?? { line: 0, column: 0 };
	const end = node.loc?.end ?? start;
	return {
		start: node.start ?? 0,
		end: node.end ?? 0,
		loc: {
			start: { line: start.line, column: start.column },
			end: { line: end.line, column: end.column },
		},
	};
}

/** Side-effect free, so it can be evaluated twice (`a`, `this`, `a.b`, `a[0]`, `a[i]`). */
function isPure(node: t.Node): boolean {
	if (
		t.isIdentifier(node) ||
		t.isThisExpression(node) ||
		t.isStringLiteral(node) ||
		t.isNumericLiteral(node)
	) {
		return true;
	}
	if (t.isMemberExpression(node)) {
		return isPure(node.object) && (!node.computed || isPure(node.property));
	}
	return false;
}

/** The key expression of `member` (`"name"` for `a.name`, the expression for `a[expr]`). */
function memberKey(
	member: t.MemberExpression,
	rewriteNode: <N extends t.Node>(n: N) => N,
): t.Expression | undefined {
	if (t.isPrivateName(member.property)) return undefined;
	if (!member.computed && t.isIdentifier(member.property)) {
		return str(member.property.name);
	}
	return t.isExpression(member.property)
		? rewriteNode(member.property)
		: undefined;
}

/** Whether `member` reads through an observable property (`store.items[0]`, `this.user.name`). */
function throughObservable(
	member: t.MemberExpression,
	plan: CompilePlan,
): boolean {
	let node: t.Node = member.object;
	while (isMember(node)) {
		if (plan.pathBases.has(spanKey(node))) return true;
		node = node.object;
	}
	return false;
}

/**
 * Rewrite a write to `member` (`=`, compound, `++` / `--`, `delete`) as a runtime helper call.
 * Returns `undefined` (and records it) if a compound write can't be rewritten safely.
 */
function rewritePropertyWrite(
	node: t.AssignmentExpression | t.UpdateExpression | t.UnaryExpression,
	member: t.MemberExpression,
	plan: CompilePlan,
	state: RewriteState,
): t.Node | undefined {
	const r = <N extends t.Node>(n: N) => rewrite(n, plan, state) as N;
	const key = memberKey(member, r);
	if (!key || !t.isExpression(member.object)) return undefined;
	const object = r(member.object);
	if (t.isUnaryExpression(node)) {
		return helper(state, "deleteProperty", [object, key]);
	}
	if (t.isUpdateExpression(node)) {
		return helper(state, "updateProperty", [
			object,
			key,
			t.valueToNode(node.operator === "++" ? 1 : -1),
			t.booleanLiteral(node.prefix),
		]);
	}
	const value = r(node.right);
	if (node.operator === "=") {
		return helper(state, "setProperty", [object, key, value]);
	}
	// target[key] op= v  ->  setProperty(target, key, getProperty(target, key) op v)
	if (!isPure(member.object) || (member.computed && !isPure(member.property))) {
		// Not known to be observable: leave it as it is.
		if (plan.untraced.has(spanKey(member))) return undefined;
		state.uncompiled.push({
			span: irSpan(node),
			message:
				"This compound assignment to an observable property can't be compiled (its object or key has side effects), so the change would not be observed. Assign to a temporary first, or use set().",
		});
		return undefined;
	}
	// The object and key are evaluated twice (they're pure): copies of their rewritten forms
	// (the plan matches source positions, which copies of the original nodes don't keep).
	const previous = helper(state, "getProperty", [
		t.cloneNode(object),
		t.cloneNode(key),
	]);
	const op = node.operator.slice(0, -1);
	// Logical assignment only assigns when it has to:
	// target[key] ||= v  ->  getProperty(target, key) || setProperty(target, key, v)
	if (op === "&&" || op === "||" || op === "??") {
		return t.logicalExpression(
			op,
			previous,
			helper(state, "setProperty", [object, key, value]),
		);
	}
	const next = t.binaryExpression(
		op as t.BinaryExpression["operator"],
		previous,
		value,
	);
	return helper(state, "setProperty", [object, key, next]);
}

const str = (value: string) => t.stringLiteral(value);

/** `obj.get("key")`, or `obj?.get("key")` when `optional`. */
function get(object: t.Expression, key: string, optional = false) {
	return optional
		? t.optionalCallExpression(
				t.optionalMemberExpression(object, t.identifier("get"), false, true),
				[str(key)],
				false,
			)
		: t.callExpression(t.memberExpression(object, t.identifier("get")), [
				str(key),
			]);
}

const method = (object: t.Expression, name: string, args: t.Expression[]) =>
	t.callExpression(t.memberExpression(object, t.identifier(name)), args);

type Member = t.MemberExpression | t.OptionalMemberExpression;
const isMember = (node: t.Node | null | undefined): node is Member =>
	t.isMemberExpression(node) || t.isOptionalMemberExpression(node);

/**
 * If `node` itself is something the plan rewrites, return its replacement (with everything
 * nested in it rewritten too); otherwise `undefined`.
 */
export function rewriteMatch(
	node: t.Node,
	plan: CompilePlan,
	state: RewriteState,
): t.Node | undefined {
	const r = <N extends t.Node>(n: N) => rewrite(n, plan, state) as N;
	const consume = (n: t.Node) => {
		state.consumed.add(spanKey(n));
	};

	// import / export ... from "<moduleSpecifier>"  ->  from "@sobx/runtime"
	if (
		(t.isImportDeclaration(node) ||
			t.isExportNamedDeclaration(node) ||
			t.isExportAllDeclaration(node)) &&
		node.source?.value === plan.moduleSpecifier
	) {
		return { ...node, source: str(RUNTIME_MODULE) } as t.Node;
	}

	if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
		const proxy = plan.proxies.get(spanKey(node));
		if (proxy && t.isCallExpression(node)) {
			const [object] = node.arguments;
			if (!t.isObjectExpression(object)) {
				state.failed.set(proxy.id, "not an object literal");
				return undefined;
			}
			const setter = object.properties.find(
				(p) => t.isObjectMethod(p) && p.kind === "set",
			);
			if (setter) {
				state.failed.set(proxy.id, "has a setter");
				return undefined;
			}
			state.needsProxyLike = true;
			const options: t.ObjectProperty[] = [];
			if (proxy.getters.length) {
				options.push(
					t.objectProperty(
						t.identifier("getters"),
						t.arrayExpression(proxy.getters.map(str)),
					),
				);
			}
			if (proxy.actions.length) {
				options.push(
					t.objectProperty(
						t.identifier("actions"),
						t.arrayExpression(proxy.actions.map(str)),
					),
				);
			}
			return t.newExpression(t.identifier(plan.proxyName), [
				r(object),
				...(options.length ? [t.objectExpression(options)] : []),
			]);
		}

		// Object.keys / values / entries(target) -> keysOf / valuesOf / entriesOf(target)
		const callee = node.callee;
		if (
			plan.operations.has(spanKey(node)) &&
			t.isMemberExpression(callee) &&
			t.isIdentifier(callee.object, { name: "Object" }) &&
			t.isIdentifier(callee.property) &&
			!callee.computed &&
			node.arguments.length === 1 &&
			t.isExpression(node.arguments[0])
		) {
			const name = {
				keys: "keysOf",
				values: "valuesOf",
				entries: "entriesOf",
			}[callee.property.name];
			if (name && state.mode !== "plain" && state.plainRead !== node) {
				consume(node);
				const [target] = node.arguments;
				return trackingRead(node, target as t.Node, plan, state, () =>
					helper(state, name, [r(target)]),
				);
			}
		}

		// s.m(...args) -> s.get("m").call(s, ...args)
		if (
			isMember(callee) &&
			plan.calls.has(spanKey(callee)) &&
			t.isExpression(callee.object)
		) {
			consume(callee);
			const key = plan.reads.get(spanKey(callee)) as string;
			const object = r(callee.object);
			const memberOptional =
				t.isOptionalMemberExpression(callee) && callee.optional;
			const callOptional = t.isOptionalCallExpression(node) && node.optional;
			const fn = get(object, key, memberOptional);
			const args = [object, ...node.arguments.map(r)] as t.Expression[];
			const inChain = memberOptional || callOptional;
			const callMember = inChain
				? t.optionalMemberExpression(
						fn,
						t.identifier("call"),
						false,
						callOptional,
					)
				: t.memberExpression(fn, t.identifier("call"));
			return inChain
				? t.optionalCallExpression(callMember, args, false)
				: t.callExpression(callMember, args);
		}
		return undefined;
	}

	if (
		t.isMemberExpression(node) &&
		t.isExpression(node.object) &&
		plan.propertyReads.has(spanKey(node)) &&
		state.mode !== "plain" &&
		state.plainRead !== node &&
		!t.isPrivateName(node.property)
	) {
		consume(node);
		const object = node.object;
		return trackingRead(node, object, plan, state, () =>
			helper(state, "getProperty", [
				r(object),
				memberKey(node, r) as t.Expression,
			]),
		);
	}

	if (isMember(node) && t.isExpression(node.object)) {
		const key = plan.reads.get(spanKey(node));
		if (key === undefined) return undefined;
		consume(node);
		return get(
			r(node.object),
			key,
			t.isOptionalMemberExpression(node) && node.optional,
		);
	}

	// key in target -> hasProperty(target, key)
	if (
		t.isBinaryExpression(node) &&
		node.operator === "in" &&
		plan.operations.has(spanKey(node)) &&
		t.isExpression(node.left) &&
		state.mode !== "plain" &&
		state.plainRead !== node
	) {
		consume(node);
		const { left, right } = node;
		return trackingRead(node, right, plan, state, () =>
			helper(state, "hasProperty", [r(right), r(left as t.Expression)]),
		);
	}

	// Writes the runtime can't observe by itself: undeclared / dynamic keys and array index /
	// `length` of runtime targets, and writes through nested values of any observable.
	const writeTarget = t.isAssignmentExpression(node)
		? node.left
		: t.isUpdateExpression(node) ||
				(t.isUnaryExpression(node) && node.operator === "delete")
			? node.argument
			: undefined;
	if (
		t.isMemberExpression(writeTarget) &&
		state.plainWrite !== node &&
		!plan.writes.has(spanKey(writeTarget)) &&
		!plan.deletes.has(spanKey(writeTarget))
	) {
		const span = spanKey(writeTarget);
		const planned = t.isUnaryExpression(node)
			? plan.propertyDeletes.has(span)
			: plan.propertyWrites.has(span);
		if (planned || throughObservable(writeTarget, plan)) {
			const out = rewritePropertyWrite(
				node as t.AssignmentExpression | t.UpdateExpression | t.UnaryExpression,
				writeTarget,
				plan,
				state,
			);
			if (out) {
				consume(writeTarget);
				return markedWrite(node, writeTarget, out, plan, state);
			}
		}
	}

	if (t.isAssignmentExpression(node)) {
		if (t.isMemberExpression(node.left) && t.isExpression(node.left.object)) {
			const key = plan.writes.get(spanKey(node.left));
			if (key === undefined) return undefined;
			consume(node.left);
			const object = r(node.left.object);
			const value = r(node.right);
			if (node.operator === "=")
				return method(object, "set", [str(key), value]);
			// s.k op= v  ->  s.set("k", s.get("k") op v)
			const op = node.operator.slice(0, -1);
			const previous = get(object, key);
			// Logical assignment only assigns when it has to: s.get("k") || s.set("k", v)
			if (op === "&&" || op === "||" || op === "??") {
				return t.logicalExpression(
					op,
					previous,
					method(object, "set", [str(key), value]),
				);
			}
			const next = t.binaryExpression(
				op as t.BinaryExpression["operator"],
				previous,
				value,
			);
			return method(object, "set", [str(key), next]);
		}
		if (t.isObjectPattern(node.left)) {
			const init = destructuredInit(node.left, node.right, plan, state);
			if (init) return { ...node, left: r(node.left), right: init };
		}
		return undefined;
	}

	if (
		t.isUpdateExpression(node) &&
		t.isMemberExpression(node.argument) &&
		t.isExpression(node.argument.object)
	) {
		const key = plan.writes.get(spanKey(node.argument));
		if (key === undefined) return undefined;
		consume(node.argument);
		// ++s.k -> s.update("k", 1, true)
		return method(r(node.argument.object), "update", [
			str(key),
			t.valueToNode(node.operator === "++" ? 1 : -1),
			t.booleanLiteral(node.prefix),
		]);
	}

	if (
		t.isUnaryExpression(node) &&
		node.operator === "delete" &&
		t.isMemberExpression(node.argument) &&
		t.isExpression(node.argument.object)
	) {
		const key = plan.deletes.get(spanKey(node.argument));
		if (key === undefined) return undefined;
		consume(node.argument);
		return method(r(node.argument.object), "delete", [str(key)]);
	}

	if (t.isVariableDeclarator(node) && t.isObjectPattern(node.id) && node.init) {
		const init = destructuredInit(node.id, node.init, plan, state);
		if (init) return { ...node, id: r(node.id), init };
		return undefined;
	}

	return undefined;
}

/**
 * `const { a, b: x } = s`: when every property of the pattern is a planned destructured read
 * of `s`, replace `s` with `{ a: s.get("a"), b: s.get("b") }`.
 */
function destructuredInit(
	pattern: t.ObjectPattern,
	init: t.Node,
	plan: CompilePlan,
	state: RewriteState,
): t.ObjectExpression | undefined {
	if (!t.isIdentifier(init) && !t.isThisExpression(init)) return undefined;
	const keys: string[] = [];
	for (const property of pattern.properties) {
		const key = plan.destructures.get(spanKey(property));
		if (key === undefined) return undefined;
		keys.push(key);
	}
	if (keys.length === 0) return undefined;
	for (const property of pattern.properties)
		state.consumed.add(spanKey(property));
	return t.objectExpression(
		keys.map((key) =>
			t.objectProperty(
				t.identifier(key).name === key && t.isValidIdentifier(key)
					? t.identifier(key)
					: str(key),
				get(t.cloneNode(init), key),
			),
		),
	);
}

/** Rewrite `node` and everything in it according to `plan`. Never mutates `node`. */
export function rewrite(
	node: t.Node,
	plan: CompilePlan,
	state: RewriteState,
): t.Node {
	const replaced = rewriteMatch(node, plan, state);
	if (replaced) return replaced;
	const keys = t.VISITOR_KEYS[node.type];
	if (!keys) return node;
	let copy: Record<string, unknown> | undefined;
	for (const k of keys) {
		const value = (node as unknown as Record<string, unknown>)[k];
		if (Array.isArray(value)) {
			let next: unknown[] | undefined;
			value.forEach((child, i) => {
				if (!child || typeof child !== "object" || !("type" in child)) return;
				const out = rewrite(child as t.Node, plan, state);
				if (out !== child) {
					next ??= [...value];
					next[i] = out;
				}
			});
			if (next) {
				copy ??= { ...node };
				copy[k] = next;
			}
		} else if (value && typeof value === "object" && "type" in value) {
			const out = rewrite(value as t.Node, plan, state);
			if (out !== value) {
				copy ??= { ...node };
				copy[k] = out;
			}
		}
	}
	return (copy as unknown as t.Node | undefined) ?? node;
}

/**
 * Build the final plan: rewrite `program` without keeping the result, and leave to the
 * runtime any fast-path observable with a use that couldn't be rewritten (for example a write
 * in a destructuring pattern). Repeats until every planned span is rewritten.
 */
export function finalizePlan(
	mod: SobxModule,
	program: t.Node,
	source: string,
): CompilePlan {
	const forced = new Map<ObservableId, string>();
	for (let attempt = 0; ; attempt++) {
		const plan = planFromModule(mod, source, forced);
		const state = newRewriteState();
		rewrite(program, plan, state);
		const before = forced.size;
		for (const [id, reason] of state.failed) forced.set(id, reason);
		for (const [key, id] of plan.owners) {
			if (plan.proxies.has(key) || state.consumed.has(key)) continue;
			if (!forced.has(id)) {
				const [start, end] = key.split(":").map(Number);
				forced.set(
					id,
					`a use that can't be compiled to get/set: ${JSON.stringify(source.slice(start, end))}`,
				);
			}
		}
		if (forced.size === before || attempt > 10) {
			plan.rewritten = state.consumed;
			plan.uncompiled = state.uncompiled;
			return plan;
		}
	}
}
