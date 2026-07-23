import { parse } from "@babel/parser";
import type { NodePath } from "@babel/traverse";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import { collectObservableBindings, getMemberKey } from "../transform.js";

/** Callees whose transformers rewrite the whole call (including body accesses). */
const SELF_CONTAINED_CALLEES = new Set(["reaction", "runInAction"]);

/** Return true if (start,end) is inside a reaction()/runInAction() call in the AST. */
function isInsideSelfContainedCall(
	program: t.Program,
	start: number,
	end: number,
): boolean {
	let inside = false;
	traverse(program, {
		noScope: true,
		CallExpression(path: NodePath<t.CallExpression>) {
			const node = path.node;
			if (
				t.isIdentifier(node.callee) &&
				SELF_CONTAINED_CALLEES.has(node.callee.name) &&
				node.start != null &&
				node.end != null &&
				start >= node.start &&
				end <= node.end
			) {
				inside = true;
				path.stop();
			}
		},
	});
	return inside;
}

/**
 * Custom transformer (unplugin-ast style): replaces obj.key with obj.get('key') when obj is an observable.
 * Skips member expressions inside reaction()/runInAction() so we don't overwrite a span already replaced.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function MemberExpressionTransformer(moduleSpecifier = "sobx") {
	return {
		onNode(
			node: t.Node,
			parent: t.Node | null | undefined,
		): node is t.MemberExpression {
			if (!t.isMemberExpression(node)) return false;
			// Skip if this is the left-hand side of an assignment (handled by AssignmentExpressionTransformer)
			if (parent && t.isAssignmentExpression(parent) && parent.left === node) {
				return false;
			}
			return t.isIdentifier(node.object);
		},

		transform(
			node: t.MemberExpression,
			code: string,
			_context: { id: string },
		) {
			if (!t.isIdentifier(node.object)) return undefined;
			const ast = parse(code, {
				sourceType: "module",
				plugins: ["typescript", "jsx"],
			});
			const program = ast.program ?? ast;
			if (
				node.start != null &&
				node.end != null &&
				isInsideSelfContainedCall(program, node.start, node.end)
			) {
				return undefined;
			}
			const observableIds = collectObservableBindings(program, moduleSpecifier);
			if (!observableIds.has(node.object.name)) return undefined;

			const key = getMemberKey(node.property);
			if (!key) return undefined;

			return t.callExpression(
				t.memberExpression(node.object, t.identifier("get")),
				[key],
			);
		},
		// biome-ignore lint/suspicious/noExplicitAny: unplugin-ast expects babel 8 Node; cast required
	} as Transformer<any>;
}
