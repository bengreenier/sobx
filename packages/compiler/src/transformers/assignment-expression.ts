import { parse } from "@babel/parser";
import type { NodePath } from "@babel/traverse";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import { collectObservableBindings, getMemberKey } from "../transform.js";

const SELF_CONTAINED_CALLEES = new Set(["reaction", "runInAction"]);

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
 * Custom transformer (unplugin-ast style): replaces obj.key = value with obj.set('key', value) when obj is an observable.
 * Skips assignments inside reaction()/runInAction() (those transformers rewrite the whole call).
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function AssignmentExpressionTransformer(moduleSpecifier = "sobx") {
	return {
		onNode(node: t.Node): node is t.AssignmentExpression {
			return (
				t.isAssignmentExpression(node) &&
				node.operator === "=" &&
				t.isMemberExpression(node.left) &&
				t.isIdentifier(node.left.object)
			);
		},

		transform(
			node: t.AssignmentExpression,
			code: string,
			_context: { id: string },
		) {
			const left = node.left;
			if (!t.isMemberExpression(left) || !t.isIdentifier(left.object))
				return undefined;
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
			const observableIds = collectObservableBindings(
				ast.program,
				moduleSpecifier,
			);
			if (!observableIds.has(left.object.name)) return undefined;

			const key = getMemberKey(left.property);
			if (!key) return undefined;

			return t.callExpression(
				t.memberExpression(left.object, t.identifier("set")),
				[key, node.right],
			);
		},
		// biome-ignore lint/suspicious/noExplicitAny: unplugin-ast expects babel 8 Node; cast required
	} as Transformer<any>;
}
