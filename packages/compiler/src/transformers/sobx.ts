import * as t from "@babel/types";
import type { Transformer } from "unplugin-ast";
import {
	type CompilePlan,
	isEmptyPlan,
	type RewriteState,
	rewriteMatch,
} from "../plan.js";
import { DEFAULT_MODULE_SPECIFIER, planSource } from "../transform.js";

const RUNTIME_IMPORT = 'import { ProxyLike } from "@sobx/runtime";\n';

interface FileState extends RewriteState {
	plan: CompilePlan;
	/** Spans already replaced; nodes inside them were rewritten along with them. */
	replaced: Array<[number, number]>;
}

/**
 * unplugin-ast transformer that compiles sobx usages. Each file is analyzed once by the native
 * analyzer; nodes are then rewritten when their span matches the analysis. unplugin-ast visits
 * nodes outermost-first, and a replaced node already contains its rewritten children, so nodes
 * inside a replaced span are skipped.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function SobxTransformer(moduleSpecifier = DEFAULT_MODULE_SPECIFIER) {
	// Per-file state, keyed by the file's source (unplugin-ast passes it to every call).
	const files = new Map<string, FileState>();
	const stateFor = (code: string, id: string): FileState => {
		let state = files.get(code);
		if (!state) {
			state = {
				plan: planSource(code, { moduleSpecifier, filename: id }),
				replaced: [],
				needsProxyLike: false,
				needsReaction: false,
			};
			files.set(code, state);
		}
		return state;
	};

	return {
		onNode(node: t.Node): boolean {
			return (
				t.isCallExpression(node) ||
				t.isMemberExpression(node) ||
				t.isAssignmentExpression(node) ||
				t.isUpdateExpression(node)
			);
		},

		transform(node: t.Node, code: string, context: { id: string }) {
			const state = stateFor(code, context.id);
			const { start, end } = node;
			if (isEmptyPlan(state.plan) || start == null || end == null)
				return undefined;
			if (state.replaced.some(([s, e]) => start >= s && end <= e))
				return undefined;
			const replacement = rewriteMatch(node, state.plan, state);
			if (!replacement) return undefined;
			state.replaced.push([start, end]);
			return replacement;
		},

		finalize(s: { original: string; prepend(content: string): unknown }) {
			const state = files.get(s.original);
			files.delete(s.original);
			if (state?.needsProxyLike) s.prepend(RUNTIME_IMPORT);
		},
		// biome-ignore lint/suspicious/noExplicitAny: unplugin-ast's Node type comes from its own @babel/types copy
	} as Transformer<any>;
}
