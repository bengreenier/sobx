import { parse } from "@babel/parser";
import type { AssignmentExpression } from "@babel/types";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import { collectObservableBindings, getMemberKey } from "../transform.js";

/**
 * Custom transformer (unplugin-ast style): replaces obj.key = value with obj.set('key', value) when obj is an observable.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function AssignmentExpressionTransformer(): Transformer<AssignmentExpression> {
	return {
		onNode(node): node is AssignmentExpression {
			return (
				node.type === "AssignmentExpression" &&
				node.operator === "=" &&
				t.isMemberExpression(node.left) &&
				t.isIdentifier(node.left.object)
			);
		},

		transform(node, code, _context) {
			const left = node.left;
			if (!t.isMemberExpression(left) || !t.isIdentifier(left.object))
				return undefined;
			const ast = parse(code, {
				sourceType: "module",
				plugins: ["typescript", "jsx"],
			});
			const observableIds = collectObservableBindings(ast.program);
			if (!observableIds.has(left.object.name)) return undefined;

			const key = getMemberKey(left.property);
			if (!key) return undefined;

			return t.callExpression(
				t.memberExpression(left.object, t.identifier("set")),
				[key, node.right],
			);
		},
	};
}
