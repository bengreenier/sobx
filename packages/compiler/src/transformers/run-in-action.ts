import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import {
	collectObservableBindings,
	getSobxImportLocalNames,
	transformObservableMemberReads,
} from "../transform.js";

/**
 * Custom transformer (unplugin-ast style): replaces runInAction(fn) with fn()
 * only when runInAction is imported from the given sobx source.
 * Transforms observable get/set inside the callback so MemberExpression /
 * AssignmentExpression transformers can skip this span (avoids magic-string conflicts).
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function RunInActionTransformer(moduleSpecifier = "sobx") {
	return {
		onNode(node: t.Node): node is t.CallExpression {
			return (
				t.isCallExpression(node) &&
				t.isIdentifier(node.callee) &&
				node.callee.name === "runInAction"
			);
		},

		transform(node: t.CallExpression, code: string, _context: { id: string }) {
			const fn = node.arguments[0];
			if (!fn || !t.isExpression(fn)) return undefined;
			const ast = parse(code, {
				sourceType: "module",
				plugins: ["typescript", "jsx"],
			});
			const { runInAction: sobxRunInActionNames } = getSobxImportLocalNames(
				ast.program,
				moduleSpecifier,
			);
			if (
				!t.isIdentifier(node.callee) ||
				!sobxRunInActionNames.has(node.callee.name)
			) {
				return undefined;
			}
			const observableIds = collectObservableBindings(
				ast.program,
				moduleSpecifier,
			);
			const fnTransformed = transformObservableMemberReads(
				fn,
				observableIds,
			) as t.Expression;
			return t.callExpression(fnTransformed, []);
		},
		// biome-ignore lint/suspicious/noExplicitAny: unplugin-ast expects babel 8 Node; cast required
	} as Transformer<any>;
}
