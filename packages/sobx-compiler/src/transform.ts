import traverse from "@babel/traverse";
import * as t from "@babel/types";

const SOBX_CORE = "@sobx/core";
const PROXY_LIKE = "ProxyLike";
const OBSERVABLE_CALLEE = "observable";
const REACTION_CALLEE = "reaction";

/**
 * Collect all binding names that are assigned a value from `observable(...)`.
 * Only handles simple patterns: `const x = observable(...)`, `let x = observable(...)`, `x = observable(...)`.
 */
export function collectObservableBindings(program: t.Program): Set<string> {
	const observableIds = new Set<string>();

	traverse(program, {
		noScope: true,
		CallExpression(path) {
			const callee = path.node.callee;
			if (
				!t.isIdentifier(callee) ||
				callee.name !== OBSERVABLE_CALLEE
			) {
				return;
			}

			const parent = path.parent;
			if (t.isVariableDeclarator(parent) && parent.init === path.node) {
				const id = parent.id;
				if (t.isIdentifier(id)) {
					observableIds.add(id.name);
				}
			} else if (
				t.isAssignmentExpression(parent) &&
				parent.right === path.node &&
				parent.operator === "="
			) {
				const left = parent.left;
				if (t.isIdentifier(left)) {
					observableIds.add(left.name);
				}
			}
		},
	});

	return observableIds;
}

/**
 * Get the property key for a MemberExpression: identifier name or computed expression.
 */
export function getMemberKey(
	property: t.MemberExpression["property"]
): t.Expression | null {
	if (t.isIdentifier(property)) {
		return t.stringLiteral(property.name);
	}
	if (t.isPrivateName(property)) {
		return null; // private fields not supported
	}
	return property;
}

/**
 * Transform the AST: observable() -> new ProxyLike(), property access -> .get()/.set(), reaction -> sobx reaction.
 */
export function transformSobx(program: t.Program): {
	ast: t.Program;
	needsProxyLike: boolean;
	needsReaction: boolean;
} {
	const observableIds = collectObservableBindings(program);
	let needsProxyLike = false;
	let needsReaction = false;

	// Clone so we don't mutate the original
	const ast = t.cloneNode(program);

	// biome-ignore lint/suspicious/noExplicitAny: babel path type is complex; we only use node, parent, parentPath, replaceWith
	const visitor: Record<string, (path: any) => void> = {
		CallExpression(path) {
			const { node } = path;

			// observable(source) -> new ProxyLike(source)
			if (
				t.isIdentifier(node.callee) &&
				node.callee.name === OBSERVABLE_CALLEE
			) {
				needsProxyLike = true;
				const arg = node.arguments[0];
				if (!arg || !t.isExpression(arg)) return;
				path.replaceWith(
					t.newExpression(t.identifier(PROXY_LIKE), [arg])
				);
				return;
			}

			// reaction(dataFn, effectFn) -> compiled reaction
			if (
				t.isIdentifier(node.callee) &&
				node.callee.name === REACTION_CALLEE
			) {
				const dataFn = node.arguments[0];
				const effectFn = node.arguments[1];
				if (
					!dataFn ||
					!effectFn ||
					!t.isExpression(dataFn) ||
					!t.isExpression(effectFn)
				) {
					return;
				}
				needsReaction = true;
				path.replaceWith(
					buildReactionExpression(dataFn, effectFn, observableIds)
				);
			}
		},

		MemberExpression(path) {
			const { node } = path;
			// Skip our own synthetic obj.get / obj.set (would re-transform forever)
			if (t.isCallExpression(path.parent) && path.parent.callee === path.node)
				return;
			if (!t.isIdentifier(node.object)) return;
			if (!observableIds.has(node.object.name)) return;

			const key = getMemberKey(node.property);
			if (!key) return;

			// Only transform reads here; assignments are handled in AssignmentExpression
			const parent = path.parent;
			if (t.isAssignmentExpression(parent) && parent.left === path.node) {
				return; // handle in AssignmentExpression
			}
			if (path.parentPath?.isOptionalMemberExpression()) return;

			// obj.key -> obj.get('key')
			path.replaceWith(
				t.callExpression(
					t.memberExpression(node.object, t.identifier("get")),
					[key]
				)
			);
		},

		AssignmentExpression(path) {
			const { node } = path;
			if (node.operator !== "=") return;
			if (!t.isMemberExpression(node.left)) return;
			const left = node.left;
			if (!t.isIdentifier(left.object)) return;
			if (!observableIds.has(left.object.name)) return;

			const key = getMemberKey(left.property);
			if (!key) return;

			// obj.key = value -> obj.set('key', value)
			path.replaceWith(
				t.callExpression(
					t.memberExpression(left.object, t.identifier("set")),
					[key, node.right]
				)
			);
		},
	};

	// First pass: observable, member, assignment; noScope to avoid scope bugs when visiting reaction() args
	traverse(ast, {
		noScope: true,
		CallExpression(path) {
			const { node } = path;
			if (
				t.isIdentifier(node.callee) &&
				node.callee.name === REACTION_CALLEE
			) {
				path.skip();
				return;
			}
			if (
				t.isIdentifier(node.callee) &&
				node.callee.name === OBSERVABLE_CALLEE
			) {
				needsProxyLike = true;
				const arg = node.arguments[0];
				if (!arg || !t.isExpression(arg)) return;
				path.replaceWith(
					t.newExpression(t.identifier(PROXY_LIKE), [arg])
				);
				return;
			}
		},
		MemberExpression: visitor.MemberExpression,
		AssignmentExpression: visitor.AssignmentExpression,
	});

	// Second pass: replace reaction() in place via manual walk (avoids Babel scope on replacement tree)
	replaceReactionCallsInPlace(ast, () => {
		needsReaction = true;
	}, (dataFn, effectFn) =>
		buildReactionExpression(dataFn, effectFn, observableIds)
	);

	const finalAst = ensureImports(ast, {
		proxyLike: needsProxyLike,
		reaction: needsReaction,
	});

	return { ast: finalAst, needsProxyLike, needsReaction };
}

/**
 * Walk the program and replace every reaction(dataFn, effectFn) call with the built IIFE.
 * Does not use Babel traverse, so no scope is built for the replacement tree.
 */
function replaceReactionCallsInPlace(
	program: t.Program,
	onReaction: () => void,
	buildReplacement: (
		dataFn: t.Expression,
		effectFn: t.Expression
	) => t.Expression
): void {
	function walk(
		node: t.Node,
		parent: Record<string, unknown> | t.Node[],
		key: string | number
	): void {
		if (
			t.isCallExpression(node) &&
			t.isIdentifier(node.callee) &&
			node.callee.name === REACTION_CALLEE
		) {
			const dataFn = node.arguments[0];
			const effectFn = node.arguments[1];
			if (
				dataFn &&
				effectFn &&
				t.isExpression(dataFn) &&
				t.isExpression(effectFn)
			) {
				onReaction();
				(parent as Record<string, unknown>)[key] = buildReplacement(
					dataFn,
					effectFn
				);
				return;
			}
		}
		const keys = t.VISITOR_KEYS[node.type];
		if (!keys) return;
		for (const k of keys) {
			const val = (node as Record<string, unknown>)[k];
			if (Array.isArray(val)) {
				for (let i = 0; i < val.length; i++) {
					const child = val[i];
					if (child && typeof child === "object" && "type" in child)
						walk(child as t.Node, val, i);
				}
			} else if (val && typeof val === "object" && "type" in val) {
				walk(val as t.Node, node as Record<string, unknown>, k);
			}
		}
	}
	for (let i = 0; i < program.body.length; i++) {
		walk(program.body[i], program.body, i);
	}
}

/**
 * Collect (observableId, key) pairs read in the data function expression/body.
 * Uses a manual walk to avoid Babel traverse scope setup on a subtree.
 */
function collectReactionReads(
	dataFn: t.Expression,
	observableIds: Set<string>
): { obj: string; key: string }[] {
	const reads: { obj: string; key: string }[] = [];

	const nodeToWalk =
		t.isArrowFunctionExpression(dataFn) || t.isFunctionExpression(dataFn)
			? dataFn
			: null;
	if (!nodeToWalk) return reads;

	function walk(node: t.Node): void {
		if (
			t.isMemberExpression(node) &&
			t.isIdentifier(node.object) &&
			observableIds.has(node.object.name) &&
			!t.isPrivateName(node.property)
		) {
			const key = t.isIdentifier(node.property)
				? node.property.name
				: t.isStringLiteral(node.property)
					? node.property.value
					: null;
			if (key != null) reads.push({ obj: node.object.name, key });
		}
		const keys = t.VISITOR_KEYS[node.type];
		if (!keys) return;
		for (const key of keys) {
			const val = (node as Record<string, unknown>)[key];
			if (Array.isArray(val)) {
				for (const child of val) {
					if (child && typeof child === "object" && "type" in child)
						walk(child as t.Node);
				}
			} else if (
				val &&
				typeof val === "object" &&
				"type" in val
			) {
				walk(val as t.Node);
			}
		}
	}
	walk(nodeToWalk);

	return reads;
}

/**
 * Replace observable member reads (obj.key) with obj.get('key') in an expression tree.
 * Used so reaction() replacement is self-contained and does not rely on MemberExpressionTransformer
 * running on its output (which would cause magic-string "already been edited" errors).
 */
export function transformObservableMemberReads(
	node: t.Node,
	observableIds: Set<string>,
	parent?: t.Node,
	parentKey?: string
): t.Node {
	if (
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object) &&
		observableIds.has(node.object.name) &&
		!(parent && t.isAssignmentExpression(parent) && parentKey === "left" && parent.left === node)
	) {
		const key = getMemberKey(node.property);
		if (!key) return t.cloneNode(node);
		return t.callExpression(
			t.memberExpression(t.identifier(node.object.name), t.identifier("get")),
			[key]
		);
	}
	const cloned = t.cloneNode(node);
	const keys = t.VISITOR_KEYS[cloned.type];
	if (!keys) return cloned;
	for (const key of keys) {
		const val = (cloned as Record<string, unknown>)[key];
		if (Array.isArray(val)) {
			for (let i = 0; i < val.length; i++) {
				const child = val[i];
				if (child && typeof child === "object" && "type" in child) {
					(val as t.Node[])[i] = transformObservableMemberReads(
						child as t.Node,
						observableIds,
						cloned as t.Node,
						key
					) as t.Node & { type: string };
				}
			}
		} else if (val && typeof val === "object" && "type" in val) {
			(cloned as Record<string, unknown>)[key] = transformObservableMemberReads(
				val as t.Node,
				observableIds,
				cloned as t.Node,
				key
			);
		}
	}
	return cloned;
}

/**
 * Build the reaction runtime call.
 * reaction(() => data, (data) => effect) -> compiled to addObserver + initial effect run.
 * Exported for use by ReactionTransformer.
 */
export function buildReactionExpression(
	dataFn: t.Expression,
	effectFn: t.Expression,
	observableIds: Set<string>
): t.Expression {
	const reads = collectReactionReads(dataFn, observableIds);
	// Clone and transform member reads to .get() so the replacement is self-contained
	// (avoids magic-string "Cannot split a chunk that has already been edited")
	const dataFnClone = transformObservableMemberReads(
		dataFn,
		observableIds
	) as t.Expression;
	const effectFnClone = transformObservableMemberReads(
		effectFn,
		observableIds
	) as t.Expression;

	if (reads.length === 0) {
		// Can't statically determine reads; use runtime reaction helper that will track
		return t.callExpression(t.identifier("__reaction"), [dataFn, effectFn]);
	}

	// Build: (() => { const __d = []; __d.push(obj.addObserver('key', (k,prev,curr) => effect(curr))); ...; effect(dataFn()); return () => __d.forEach(x => x.dispose()); })()
	const disposersId = t.identifier("__d");
	const statements: t.Statement[] = [
		t.variableDeclaration("const", [
			t.variableDeclarator(
				disposersId,
				t.arrayExpression([])
			),
		]),
	];

	for (const { obj, key } of reads) {
		const objId = t.identifier(obj);
		const keyLit = t.stringLiteral(key);
		const addObserverCall = t.callExpression(
			t.memberExpression(objId, t.identifier("addObserver")),
			[
				keyLit,
				t.arrowFunctionExpression(
					[
						t.identifier("_k"),
						t.identifier("_prev"),
						t.identifier("curr"),
					],
					t.callExpression(effectFnClone, [t.identifier("curr")])
				),
			]
		);
		statements.push(
			t.expressionStatement(
				t.callExpression(
					t.memberExpression(disposersId, t.identifier("push")),
					[addObserverCall]
				)
			)
		);
	}

	// Run effect once with initial value: effect(dataFn())
	statements.push(
		t.expressionStatement(
			t.callExpression(effectFnClone, [
				t.callExpression(dataFnClone, []),
			])
		)
	);

	// Return disposer
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
										t.memberExpression(t.identifier("x"), t.identifier("dispose")),
										[]
									)
								),
							]
						)
					),
				])
			)
		)
	);

	return t.callExpression(
		t.arrowFunctionExpression([], t.blockStatement(statements)),
		[]
	);
}

/**
 * Ensure the program has the necessary imports from @sobx/core.
 */
export function ensureImports(
	program: t.Program,
	opts: { proxyLike: boolean; reaction: boolean }
): t.Program {
	const specifiers: t.ImportSpecifier[] = [];
	if (opts.proxyLike) {
		specifiers.push(
			t.importSpecifier(t.identifier(PROXY_LIKE), t.identifier(PROXY_LIKE))
		);
	}
	if (opts.reaction) {
		// We use __reaction only when we can't statically analyze; for now no runtime reaction
		// specifiers.push(t.importSpecifier(t.identifier('reaction'), t.identifier('reaction')));
	}

	if (specifiers.length === 0) return program;

	const importDecl = t.importDeclaration(
		specifiers,
		t.stringLiteral(SOBX_CORE)
	);

	const body = [...program.body];
	// Insert after existing imports
	let insertIndex = 0;
	for (let i = 0; i < body.length; i++) {
		if (t.isImportDeclaration(body[i])) {
			insertIndex = i + 1;
		} else {
			break;
		}
	}
	body.splice(insertIndex, 0, importDecl);

	return t.program(body, program.directives);
}
