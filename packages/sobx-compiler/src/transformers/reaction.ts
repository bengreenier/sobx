import { parse } from "@babel/parser";
import type { CallExpression } from "@babel/types";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import {
	buildReactionExpression,
	collectObservableBindings,
} from "../transform.js";

/**
 * Custom transformer (unplugin-ast style): compiles reaction(dataFn, effectFn) to addObserver + effect.
 * Needs full file code to resolve observable bindings.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function ReactionTransformer(): Transformer<CallExpression> {
	return {
		onNode(node): node is CallExpression {
			return (
				node.type === "CallExpression" &&
				t.isIdentifier(node.callee) &&
				node.callee.name === "reaction"
			);
		},

		transform(node, code, _context) {
			const dataFn = node.arguments[0];
			const effectFn = node.arguments[1];
			if (
				!dataFn ||
				!effectFn ||
				!t.isExpression(dataFn) ||
				!t.isExpression(effectFn)
			) {
				return undefined;
			}
			const ast = parse(code, {
				sourceType: "module",
				plugins: ["typescript", "jsx"],
			});
			const observableIds = collectObservableBindings(ast.program);
			return buildReactionExpression(dataFn, effectFn, observableIds);
		},
	};
}
