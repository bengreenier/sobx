import type { NodePath } from "@babel/traverse";
import traverse from "@babel/traverse";
import * as t from "@babel/types";

const SOBX_CORE = "@sobx/core";
const PROXY_LIKE = "ProxyLike";
const OBSERVABLE_CALLEE = "observable";
const REACTION_CALLEE = "reaction";
const RUN_IN_ACTION_CALLEE = "runInAction";

const DEFAULT_MODULE_SPECIFIER = "sobx";

export interface SobxImportLocalNames {
	observable: Set<string>;
	reaction: Set<string>;
	runInAction: Set<string>;
}

export interface TransformSobxOptions {
	/** Module specifier to treat as sobx (only transform when imported from here). Default `"sobx"`. */
	moduleSpecifier?: string;
}

/**
 * Collect local names that are bound to `observable`, `reaction`, or `runInAction` from an import of the given source.
 * Handles named imports and aliases (e.g. `import { observable as o } from "sobx"` → o in observable set).
 */
export function getSobxImportLocalNames(
	program: t.Program,
	moduleSpecifier: string = DEFAULT_MODULE_SPECIFIER,
): SobxImportLocalNames {
	const observable = new Set<string>();
	const reaction = new Set<string>();
	const runInAction = new Set<string>();

	for (const stmt of program.body) {
		if (!t.isImportDeclaration(stmt)) continue;
		const source = stmt.source;
		if (!t.isStringLiteral(source) || source.value !== moduleSpecifier)
			continue;

		for (const spec of stmt.specifiers) {
			if (!t.isImportSpecifier(spec)) continue;
			const importedName = t.isIdentifier(spec.imported)
				? spec.imported.name
				: t.isStringLiteral(spec.imported)
					? spec.imported.value
					: null;
			if (importedName == null) continue;
			const local = spec.local.name;
			if (importedName === OBSERVABLE_CALLEE) observable.add(local);
			if (importedName === REACTION_CALLEE) reaction.add(local);
			if (importedName === RUN_IN_ACTION_CALLEE) runInAction.add(local);
		}
	}

	return { observable, reaction, runInAction };
}

/**
 * Collect all binding names that are assigned a value from `observable(...)` when that call
 * refers to `observable` imported from the given sobx source.
 * Only handles simple patterns: `const x = observable(...)`, `let x = observable(...)`, `x = observable(...)`.
 */
export function collectObservableBindings(
	program: t.Program,
	moduleSpecifier: string = DEFAULT_MODULE_SPECIFIER,
): Set<string> {
	const { observable: sobxObservableNames } = getSobxImportLocalNames(
		program,
		moduleSpecifier,
	);
	const observableIds = new Set<string>();

	traverse(program, {
		noScope: true,
		CallExpression(path: NodePath<t.CallExpression>) {
			const callee = path.node.callee;
			if (
				!t.isIdentifier(callee) ||
				callee.name !== OBSERVABLE_CALLEE ||
				!sobxObservableNames.has(callee.name)
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
	property: t.MemberExpression["property"],
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
export function transformSobx(
	program: t.Program,
	options: TransformSobxOptions = {},
): {
	ast: t.Program;
	needsProxyLike: boolean;
	needsReaction: boolean;
} {
	const moduleSpecifier = options.moduleSpecifier ?? DEFAULT_MODULE_SPECIFIER;
	const sobxNames = getSobxImportLocalNames(program, moduleSpecifier);
	const observableIds = collectObservableBindings(program, moduleSpecifier);
	let needsProxyLike = false;
	let needsReaction = false;

	// Clone so we don't mutate the original
	const ast = t.cloneNode(program);

	// biome-ignore lint/suspicious/noExplicitAny: babel path type is complex; we only use node, parent, parentPath, replaceWith
	const visitor: Record<string, (path: any) => void> = {
		CallExpression(path) {
			const { node } = path;

			// observable(source) -> new ProxyLike(source) only when from sobx
			if (
				t.isIdentifier(node.callee) &&
				sobxNames.observable.has(node.callee.name)
			) {
				needsProxyLike = true;
				const arg = node.arguments[0];
				if (!arg || !t.isExpression(arg)) return;
				path.replaceWith(t.newExpression(t.identifier(PROXY_LIKE), [arg]));
				return;
			}

			// runInAction(fn) -> fn() only when from sobx (transform body accesses first)
			if (
				t.isIdentifier(node.callee) &&
				sobxNames.runInAction.has(node.callee.name)
			) {
				const fn = node.arguments[0];
				if (!fn || !t.isExpression(fn)) return;
				path.replaceWith(
					t.callExpression(
						transformObservableMemberReads(fn, observableIds) as t.Expression,
						[],
					),
				);
				return;
			}

			// reaction(dataFn, effectFn) -> compiled reaction only when from sobx
			if (
				t.isIdentifier(node.callee) &&
				sobxNames.reaction.has(node.callee.name)
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
					buildReactionExpression(dataFn, effectFn, observableIds),
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
				t.callExpression(t.memberExpression(node.object, t.identifier("get")), [
					key,
				]),
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
				t.callExpression(t.memberExpression(left.object, t.identifier("set")), [
					key,
					node.right,
				]),
			);
		},
	};

	// First pass: observable, member, assignment; noScope to avoid scope bugs when visiting reaction() args
	traverse(ast, {
		noScope: true,
		CallExpression(path: NodePath<t.CallExpression>) {
			const { node } = path;
			if (
				t.isIdentifier(node.callee) &&
				sobxNames.reaction.has(node.callee.name)
			) {
				path.skip();
				return;
			}
			if (
				t.isIdentifier(node.callee) &&
				sobxNames.observable.has(node.callee.name)
			) {
				needsProxyLike = true;
				const arg = node.arguments[0];
				if (!arg || !t.isExpression(arg)) return;
				path.replaceWith(t.newExpression(t.identifier(PROXY_LIKE), [arg]));
				return;
			}
			if (
				t.isIdentifier(node.callee) &&
				sobxNames.runInAction.has(node.callee.name)
			) {
				const fn = node.arguments[0];
				if (!fn || !t.isExpression(fn)) return;
				path.replaceWith(
					t.callExpression(
						transformObservableMemberReads(fn, observableIds) as t.Expression,
						[],
					),
				);
				return;
			}
		},
		MemberExpression: visitor.MemberExpression,
		AssignmentExpression: visitor.AssignmentExpression,
	});

	// Second pass: replace reaction() in place via manual walk (avoids Babel scope on replacement tree)
	replaceReactionCallsInPlace(
		ast,
		sobxNames.reaction,
		() => {
			needsReaction = true;
		},
		(dataFn, effectFn) =>
			buildReactionExpression(dataFn, effectFn, observableIds),
	);

	const finalAst = ensureImports(ast, {
		proxyLike: needsProxyLike,
		reaction: needsReaction,
	});

	return { ast: finalAst, needsProxyLike, needsReaction };
}

/**
 * Walk the program and replace every reaction(dataFn, effectFn) call with the built IIFE
 * when the callee is a reference to reaction imported from "sobx".
 * Does not use Babel traverse, so no scope is built for the replacement tree.
 */
function replaceReactionCallsInPlace(
	program: t.Program,
	reactionLocalNames: Set<string>,
	onReaction: () => void,
	buildReplacement: (
		dataFn: t.Expression,
		effectFn: t.Expression,
	) => t.Expression,
): void {
	function walk(
		node: t.Node,
		parent: Record<string, unknown> | t.Node[],
		key: string | number,
	): void {
		if (
			t.isCallExpression(node) &&
			t.isIdentifier(node.callee) &&
			reactionLocalNames.has(node.callee.name)
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
				(parent as unknown as Record<string, unknown>)[key] = buildReplacement(
					dataFn,
					effectFn,
				);
				return;
			}
		}
		const keys = t.VISITOR_KEYS[node.type];
		if (!keys) return;
		for (const k of keys) {
			const val = (node as unknown as Record<string, unknown>)[k];
			if (Array.isArray(val)) {
				for (let i = 0; i < val.length; i++) {
					const child = val[i];
					if (child && typeof child === "object" && "type" in child)
						walk(child as t.Node, val, i);
				}
			} else if (val && typeof val === "object" && "type" in val) {
				walk(val as t.Node, node as unknown as Record<string, unknown>, k);
			}
		}
	}
	for (let i = 0; i < program.body.length; i++) {
		const stmt = program.body[i];
		if (stmt !== undefined) walk(stmt, program.body, i);
	}
}

/**
 * Collect (observableId, key) pairs read in the data function expression/body.
 * Uses a manual walk to avoid Babel traverse scope setup on a subtree.
 */
function collectReactionReads(
	dataFn: t.Expression,
	observableIds: Set<string>,
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
			const val = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(val)) {
				for (const child of val) {
					if (child && typeof child === "object" && "type" in child)
						walk(child as t.Node);
				}
			} else if (val && typeof val === "object" && "type" in val) {
				walk(val as t.Node);
			}
		}
	}
	walk(nodeToWalk);

	return reads;
}

/**
 * Replace observable member reads (obj.key → obj.get('key')) and writes
 * (obj.key = value → obj.set('key', value)) in an expression/statement tree.
 * Used so reaction() / runInAction() replacements are self-contained and do not
 * rely on MemberExpressionTransformer / AssignmentExpressionTransformer running
 * on their output (which would cause magic-string "already been edited" errors).
 */
export function transformObservableMemberReads(
	node: t.Node,
	observableIds: Set<string>,
	parent?: t.Node,
	parentKey?: string,
): t.Node {
	if (
		t.isAssignmentExpression(node) &&
		node.operator === "=" &&
		t.isMemberExpression(node.left) &&
		t.isIdentifier(node.left.object) &&
		observableIds.has(node.left.object.name)
	) {
		const key = getMemberKey(node.left.property);
		if (!key) return t.cloneNode(node);
		const right = transformObservableMemberReads(
			node.right,
			observableIds,
			node,
			"right",
		) as t.Expression;
		return t.callExpression(
			t.memberExpression(
				t.identifier(node.left.object.name),
				t.identifier("set"),
			),
			[key, right],
		);
	}
	if (
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object) &&
		observableIds.has(node.object.name) &&
		!(
			parent &&
			t.isAssignmentExpression(parent) &&
			parentKey === "left" &&
			parent.left === node
		)
	) {
		const key = getMemberKey(node.property);
		if (!key) return t.cloneNode(node);
		return t.callExpression(
			t.memberExpression(t.identifier(node.object.name), t.identifier("get")),
			[key],
		);
	}
	const cloned = t.cloneNode(node);
	const keys = t.VISITOR_KEYS[cloned.type];
	if (!keys) return cloned;
	for (const key of keys) {
		const val = (cloned as unknown as Record<string, unknown>)[key];
		if (Array.isArray(val)) {
			for (let i = 0; i < val.length; i++) {
				const child = val[i];
				if (child && typeof child === "object" && "type" in child) {
					(val as t.Node[])[i] = transformObservableMemberReads(
						child as t.Node,
						observableIds,
						cloned as t.Node,
						key,
					) as t.Node & { type: string };
				}
			}
		} else if (val && typeof val === "object" && "type" in val) {
			(cloned as unknown as Record<string, unknown>)[key] =
				transformObservableMemberReads(
					val as t.Node,
					observableIds,
					cloned as t.Node,
					key,
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
	observableIds: Set<string>,
): t.Expression {
	const reads = collectReactionReads(dataFn, observableIds);
	// Clone and transform member reads to .get() so the replacement is self-contained
	// (avoids magic-string "Cannot split a chunk that has already been edited")
	const dataFnClone = transformObservableMemberReads(
		dataFn,
		observableIds,
	) as t.Expression;
	const effectFnClone = transformObservableMemberReads(
		effectFn,
		observableIds,
	) as t.Expression;

	if (reads.length === 0) {
		// Can't statically determine reads; use runtime reaction helper that will track
		return t.callExpression(t.identifier("__reaction"), [dataFn, effectFn]);
	}

	// Build: (() => { const __d = []; __d.push(obj.addObserver('key', (k,prev,curr) => effect(curr))); ...; effect(dataFn()); return () => __d.forEach(x => x.dispose()); })()
	const disposersId = t.identifier("__d");
	const statements: t.Statement[] = [
		t.variableDeclaration("const", [
			t.variableDeclarator(disposersId, t.arrayExpression([])),
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
					[t.identifier("_k"), t.identifier("_prev"), t.identifier("curr")],
					t.callExpression(effectFnClone, [t.identifier("curr")]),
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

	// Run effect once with initial value: effect(dataFn())
	statements.push(
		t.expressionStatement(
			t.callExpression(effectFnClone, [t.callExpression(dataFnClone, [])]),
		),
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

/**
 * Ensure the program has the necessary imports from @sobx/core.
 */
export function ensureImports(
	program: t.Program,
	opts: { proxyLike: boolean; reaction: boolean },
): t.Program {
	const specifiers: t.ImportSpecifier[] = [];
	if (opts.proxyLike) {
		specifiers.push(
			t.importSpecifier(t.identifier(PROXY_LIKE), t.identifier(PROXY_LIKE)),
		);
	}
	if (opts.reaction) {
		// We use __reaction only when we can't statically analyze; for now no runtime reaction
		// specifiers.push(t.importSpecifier(t.identifier('reaction'), t.identifier('reaction')));
	}

	if (specifiers.length === 0) return program;

	const importDecl = t.importDeclaration(
		specifiers,
		t.stringLiteral(SOBX_CORE),
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
