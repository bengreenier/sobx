import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import {
	buildReactionExpression,
	collectObservableBindings,
	getSobxImportLocalNames,
} from "../transform.js";

/**
 * Custom transformer (unplugin-ast style): compiles reaction(dataFn, effectFn) to addObserver + effect
 * only when reaction is imported from the given sobx source.
 * Needs full file code to resolve observable bindings.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function ReactionTransformer(moduleSpecifier = "sobx") {
	return {
		onNode(node: t.Node): node is t.CallExpression {
			return (
				t.isCallExpression(node) &&
				t.isIdentifier(node.callee) &&
				node.callee.name === "reaction"
			);
		},

		transform(node: t.CallExpression, code: string, _context: { id: string }) {
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
			const { reaction: sobxReactionNames } = getSobxImportLocalNames(
				ast.program,
				moduleSpecifier,
			);
			if (
				!t.isIdentifier(node.callee) ||
				!sobxReactionNames.has(node.callee.name)
			)
				return undefined;
			const observableIds = collectObservableBindings(
				ast.program,
				moduleSpecifier,
			);
			return buildReactionExpression(dataFn, effectFn, observableIds);
		},
		// biome-ignore lint/suspicious/noExplicitAny: unplugin-ast expects babel 8 Node; cast required
	} as Transformer<any>;
}
