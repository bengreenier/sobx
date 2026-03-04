import AST from "unplugin-ast/vite";
import type { Plugin } from "vite";
import { ObservableTransformer } from "./transformers/observable.js";
import { ReactionTransformer } from "./transformers/reaction.js";
import { MemberExpressionTransformer } from "./transformers/member-expression.js";
import { AssignmentExpressionTransformer } from "./transformers/assignment-expression.js";
import { ImportInjectionTransformer } from "./transformers/import-injection.js";

export interface SobxCompilerOptions {
	/**
	 * Include pattern for files to transform (default: /\.[jt]sx?$/).
	 */
	include?: string | RegExp | (string | RegExp)[];
	/**
	 * Exclude pattern for files to skip.
	 */
	exclude?: string | RegExp | (string | RegExp)[];
}

/**
 * Vite plugin that compiles MobX-style code (observable, direct property access, reaction)
 * to sobx-compatible code using unplugin-ast custom transformers.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function sobxCompiler(options: SobxCompilerOptions = {}): Plugin[] {
	const { include = /\.[jt]sx?$/, exclude } = options;

	return [
		AST({
			include: include as RegExp,
			exclude,
			transformer: [
				ObservableTransformer(),
				ReactionTransformer(),
				MemberExpressionTransformer(),
				AssignmentExpressionTransformer(),
				ImportInjectionTransformer(),
			],
		}) as Plugin,
	];
}
