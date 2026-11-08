import * as t from "@babel/types";
import type { ObservableId, ReadAccess, SobxModule } from "@sobx/ast";

const PROXY_LIKE = "ProxyLike";

/** An observed `(binding, key)` pair of a compiled reaction. */
export interface ReactionRead {
	obj: string;
	key: string;
}

/**
 * What to rewrite in a module, keyed by source span (`"start:end"`), derived from the analyzer's
 * IR. Only `observable({...})` objects are compiled (to `ProxyLike`), along with `reaction` and
 * `runInAction`; classes and the other APIs are left alone.
 */
export interface CompilePlan {
	/** `observable(...)` calls to replace with `new ProxyLike(...)`. */
	observableCalls: Set<string>;
	/** Member reads (`store.key`) to replace with `store.get("key")`, by member span. */
	reads: Map<string, string>;
	/** Writes to replace with `store.set("key", ...)`, by the target member's span. */
	writes: Map<string, string>;
	/** `reaction(data, effect)` calls to compile, with the reads they observe. */
	reactions: Map<string, ReactionRead[]>;
	/** `runInAction(fn)` calls to replace with `fn()` (there is no batching to do). */
	runInActions: Set<string>;
}

export function spanKey(span: { start?: number | null; end?: number | null }) {
	return `${span.start}:${span.end}`;
}

export function isEmptyPlan(plan: CompilePlan): boolean {
	return (
		plan.observableCalls.size === 0 &&
		plan.reads.size === 0 &&
		plan.writes.size === 0 &&
		plan.reactions.size === 0 &&
		plan.runInActions.size === 0
	);
}

export function emptyPlan(): CompilePlan {
	return {
		observableCalls: new Set(),
		reads: new Map(),
		writes: new Map(),
		reactions: new Map(),
		runInActions: new Set(),
	};
}

/** Build a {@link CompilePlan} from a module's IR. */
export function planFromModule(mod: SobxModule): CompilePlan {
	const plan = emptyPlan();
	const compiled = new Map<ObservableId, string | null>();
	for (const o of mod.observables) {
		if (o.target !== "object" || o.source !== "observable") continue;
		compiled.set(o.id, o.binding?.name ?? null);
		plan.observableCalls.add(spanKey(o.span));
	}

	const rewritable = (a: { observable: ObservableId; receiver: string }) =>
		a.receiver === "binding" && compiled.has(a.observable);
	const reads = new Map<string, ReadAccess>();
	for (const a of mod.accesses) {
		if (a.kind === "ComputedRead" || a.key.kind !== "static" || !rewritable(a))
			continue;
		if (a.kind === "Read" && a.via === "member") {
			plan.reads.set(spanKey(a.span), a.key.name);
			reads.set(a.id, a);
		} else if (a.kind === "Write") {
			plan.writes.set(spanKey(a.span), a.key.name);
		}
	}

	for (const r of mod.reactions) {
		if (r.api !== "reaction") continue;
		// Everything read while the data function runs: directly, in functions nested in it,
		// and in local functions / observable methods it calls.
		const tracked = mod.accesses
			.filter(
				(a) =>
					(a.context.kind === "tracked" ||
						a.context.kind === "tracked-nested") &&
					a.context.by === r.id,
			)
			.map((a) => a.id);
		const observed: ReactionRead[] = [];
		const seen = new Set<string>();
		for (const id of [...tracked, ...r.indirectDependencies]) {
			const a = reads.get(id);
			const obj = a ? compiled.get(a.observable) : null;
			if (!a || !obj || a.key.kind !== "static") continue;
			const pair = `${obj}\0${a.key.name}`;
			if (seen.has(pair)) continue;
			seen.add(pair);
			observed.push({ obj, key: a.key.name });
		}
		plan.reactions.set(spanKey(r.span), observed);
	}

	for (const a of mod.actions) {
		if (a.source.kind === "runInAction") plan.runInActions.add(spanKey(a.span));
	}
	return plan;
}

/** Mutable state collected while rewriting. */
export interface RewriteState {
	needsProxyLike: boolean;
	needsReaction: boolean;
}

const get = (object: t.Expression, key: string) =>
	t.callExpression(t.memberExpression(object, t.identifier("get")), [
		t.stringLiteral(key),
	]);
const set = (object: t.Expression, key: string, value: t.Expression) =>
	t.callExpression(t.memberExpression(object, t.identifier("set")), [
		t.stringLiteral(key),
		value,
	]);

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

	if (t.isCallExpression(node)) {
		const key = spanKey(node);
		if (plan.observableCalls.has(key)) {
			state.needsProxyLike = true;
			return t.newExpression(t.identifier(PROXY_LIKE), node.arguments.map(r));
		}
		const observed = plan.reactions.get(key);
		const [dataFn, effectFn] = node.arguments;
		if (
			observed &&
			dataFn &&
			effectFn &&
			t.isExpression(dataFn) &&
			t.isExpression(effectFn)
		) {
			state.needsReaction = true;
			return buildReactionExpression(r(dataFn), r(effectFn), observed);
		}
		const [fn] = node.arguments;
		if (plan.runInActions.has(key) && fn && t.isExpression(fn)) {
			// `runInAction(fn)` -> `fn()`
			return t.callExpression(r(fn), []);
		}
		return undefined;
	}

	if (t.isMemberExpression(node) && t.isExpression(node.object)) {
		const key = plan.reads.get(spanKey(node));
		if (key === undefined) return undefined;
		return get(r(node.object), key);
	}

	if (
		t.isAssignmentExpression(node) &&
		t.isMemberExpression(node.left) &&
		t.isExpression(node.left.object)
	) {
		const key = plan.writes.get(spanKey(node.left));
		if (key === undefined) return undefined;
		const object = r(node.left.object);
		const value = r(node.right);
		if (node.operator === "=") return set(object, key, value);
		// `store.k op= v` -> `store.set("k", store.get("k") op v)`
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
		return set(object, key, next);
	}

	if (
		t.isUpdateExpression(node) &&
		t.isMemberExpression(node.argument) &&
		t.isExpression(node.argument.object)
	) {
		const key = plan.writes.get(spanKey(node.argument));
		if (key === undefined) return undefined;
		// `++store.k` -> `(store.set("k", store.get("k") + 1), store.get("k"))`; postfix yields
		// the previous value instead.
		const object = r(node.argument.object);
		const op = node.operator === "++" ? "+" : "-";
		const back = node.operator === "++" ? "-" : "+";
		const updated = set(
			object,
			key,
			t.binaryExpression(op, get(object, key), t.numericLiteral(1)),
		);
		const result = node.prefix
			? get(object, key)
			: t.binaryExpression(back, get(object, key), t.numericLiteral(1));
		return t.sequenceExpression([updated, result]);
	}

	return undefined;
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
 * Build the compiled form of `reaction(dataFn, effectFn)`: observe each read key with
 * `addObserver`, run the effect once with the initial value, and return a disposer.
 * `dataFn` / `effectFn` should already be rewritten. Without any statically known reads,
 * falls back to a `__reaction(dataFn, effectFn)` call.
 */
export function buildReactionExpression(
	dataFn: t.Expression,
	effectFn: t.Expression,
	reads: ReactionRead[],
): t.Expression {
	if (reads.length === 0) {
		return t.callExpression(t.identifier("__reaction"), [dataFn, effectFn]);
	}

	// (() => { const __d = []; __d.push(obj.addObserver("key", (_k, _prev, curr) => effect(curr))); ...;
	//          effect(dataFn()); return () => { __d.forEach(x => x.dispose()); }; })()
	const disposersId = t.identifier("__d");
	const statements: t.Statement[] = [
		t.variableDeclaration("const", [
			t.variableDeclarator(disposersId, t.arrayExpression([])),
		]),
	];

	for (const { obj, key } of reads) {
		const addObserverCall = t.callExpression(
			t.memberExpression(t.identifier(obj), t.identifier("addObserver")),
			[
				t.stringLiteral(key),
				t.arrowFunctionExpression(
					[t.identifier("_k"), t.identifier("_prev"), t.identifier("curr")],
					t.callExpression(effectFn, [t.identifier("curr")]),
				),
			],
		);
		statements.push(
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(disposersId, t.identifier("push")),
					[addObserverCall],
				),
			),
		);
	}

	statements.push(
		t.expressionStatement(
			t.callExpression(effectFn, [t.callExpression(dataFn, [])]),
		),
	);

	statements.push(
		t.returnStatement(
			t.arrowFunctionExpression(
				[],
				t.blockStatement([
					t.expressionStatement(
						t.callExpression(
							t.memberExpression(disposersId, t.identifier("forEach")),
							[
								t.arrowFunctionExpression(
									[t.identifier("x")],
									t.callExpression(
										t.memberExpression(
											t.identifier("x"),
											t.identifier("dispose"),
										),
										[],
									),
								),
							],
						),
					),
				]),
			),
		),
	);

	return t.callExpression(
		t.arrowFunctionExpression([], t.blockStatement(statements)),
		[],
	);
}
