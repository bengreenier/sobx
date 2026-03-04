import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import type { MemberExpression } from "@babel/types";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import { collectObservableBindings, getMemberKey } from "../transform.js";

/** Return true if (start,end) is inside a reaction() call in the AST. */
function isInsideReactionCall(
	ast: t.Program,
	start: number,
	end: number,
): boolean {
	let inside = false;
	traverse(ast, {
		noScope: true,
		CallExpression(path) {
			const node = path.node;
			if (
				t.isIdentifier(node.callee) &&
				node.callee.name === "reaction" &&
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
 * Skips member expressions inside reaction() so we don't overwrite a span already replaced by ReactionTransformer.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function MemberExpressionTransformer(): Transformer<MemberExpression> {
	return {
		onNode(node, parent): node is MemberExpression {
			if (node.type !== "MemberExpression") return false;
			// Skip if this is the left-hand side of an assignment (handled by AssignmentExpressionTransformer)
			if (t.isAssignmentExpression(parent) && parent.left === node) {
				return false;
			}
			return t.isIdentifier(node.object);
		},

		transform(node, code, _context) {
			if (!t.isIdentifier(node.object)) return undefined;
			const ast = parse(code, {
				sourceType: "module",
				plugins: ["typescript", "jsx"],
			});
			// Skip if inside reaction() – ReactionTransformer replaces the whole call and uses transformObservableMemberReads
			if (
				node.start != null &&
				node.end != null &&
				isInsideReactionCall(ast, node.start, node.end)
			) {
				return undefined;
			}
			const observableIds = collectObservableBindings(ast.program);
			if (!observableIds.has(node.object.name)) return undefined;

			const key = getMemberKey(node.property);
			if (!key) return undefined;

			return t.callExpression(
				t.memberExpression(node.object, t.identifier("get")),
				[key],
			);
		},
	};
}
