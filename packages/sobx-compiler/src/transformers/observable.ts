import type { CallExpression } from "@babel/types";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";

const PROXY_LIKE = "ProxyLike";

/**
 * Custom transformer (unplugin-ast style): replaces observable(source) with new ProxyLike(source).
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function ObservableTransformer(): Transformer<CallExpression> {
	return {
		onNode(node): node is CallExpression {
			return (
				node.type === "CallExpression" &&
				t.isIdentifier(node.callee) &&
				node.callee.name === "observable"
			);
		},

		transform(node, _code, _context) {
			const arg = node.arguments[0];
			if (!arg || !t.isExpression(arg)) return undefined;
			return t.newExpression(t.identifier(PROXY_LIKE), [arg]);
		},
	};
}
