import * as t from "@babel/types";
import type { ObservableId, SobxModule } from "@sobx/ast";

export const RUNTIME_MODULE = "@sobx/runtime";

/** A local `observable({...})` compiled to a `ProxyLike`. */
export interface ProxyObservable {
	id: ObservableId;
	/** Getter keys (run with the `ProxyLike` as `this`). */
	getters: string[];
	/** Function keys wrapped as actions. */
	actions: string[];
}

/**
 * What to rewrite in a module, keyed by source span (`"start:end"`), derived from the analyzer's
 * IR (and checked against the AST by {@link finalizePlan}).
 *
 * Imports from the API module are redirected to `@sobx/runtime`, which implements the API. On
 * top of that, local `observable({...})` objects whose every use can be rewritten are compiled
 * to a `ProxyLike` with explicit `get` / `set` calls (the fast path). Every other observable is
 * left to the runtime.
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
	return plan;
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
	/** Planned spans that were rewritten. */
	consumed: Set<string>;
	/** Observables whose literal turned out not to fit the fast path. */
	failed: Map<ObservableId, string>;
}

export function newRewriteState(): RewriteState {
	return { needsProxyLike: false, consumed: new Set(), failed: new Map() };
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

		// s.m(...args) -> s.get("m").call(s, ...args)
		const callee = node.callee;
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
			const next =
				op === "&&" || op === "||" || op === "??"
					? t.logicalExpression(op, previous, value)
					: t.binaryExpression(
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
		if (forced.size === before || attempt > 10) return plan;
	}
}
