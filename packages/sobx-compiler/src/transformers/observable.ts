import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import { getSobxImportLocalNames } from "../transform.js";

const PROXY_LIKE = "ProxyLike";

/**
 * Custom transformer (unplugin-ast style): replaces observable(source) with new ProxyLike(source)
 * only when observable is imported from the given sobx source.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function ObservableTransformer(moduleSpecifier = "sobx") {
	return {
		onNode(node: t.Node): node is t.CallExpression {
			return (
				t.isCallExpression(node) &&
				t.isIdentifier(node.callee) &&
				node.callee.name === "observable"
			);
		},

		transform(node: t.CallExpression, code: string, _context: { id: string }) {
			const arg = node.arguments[0];
			if (!arg || !t.isExpression(arg)) return undefined;
			const ast = parse(code, {
				sourceType: "module",
				plugins: ["typescript", "jsx"],
			});
			const { observable: sobxObservableNames } = getSobxImportLocalNames(
				ast.program,
				moduleSpecifier,
			);
			if (
				!t.isIdentifier(node.callee) ||
				!sobxObservableNames.has(node.callee.name)
			)
				return undefined;
			return t.newExpression(t.identifier(PROXY_LIKE), [arg]);
		},
		// biome-ignore lint/suspicious/noExplicitAny: unplugin-ast expects babel 8 Node; we use babel 7, cast required
	} as Transformer<any>;
}
