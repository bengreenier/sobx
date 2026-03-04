import type { MemberExpression } from "@babel/types";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import {
	collectObservableBindings,
	getMemberKey,
} from "../transform.js";

/**
 * Custom transformer (unplugin-ast style): replaces obj.key with obj.get('key') when obj is an observable.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function MemberExpressionTransformer(): Transformer<MemberExpression> {
	return {
		onNode(node, parent): node is MemberExpression {
			if (node.type !== "MemberExpression") return false;
			// Skip if this is the left-hand side of an assignment (handled by AssignmentExpressionTransformer)
			if (
				t.isAssignmentExpression(parent) &&
				parent.left === node
			) {
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
			const observableIds = collectObservableBindings(ast.program);
			if (!observableIds.has(node.object.name)) return undefined;

			const key = getMemberKey(node.property);
			if (!key) return undefined;

			return t.callExpression(
				t.memberExpression(node.object, t.identifier("get")),
				[key]
			);
		},
	};
}
