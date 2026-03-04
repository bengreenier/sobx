import { AssignmentExpressionTransformer } from "./transformers/assignment-expression.js";
import { ImportInjectionTransformer } from "./transformers/import-injection.js";
import { MemberExpressionTransformer } from "./transformers/member-expression.js";
import { ObservableTransformer } from "./transformers/observable.js";
import { ReactionTransformer } from "./transformers/reaction.js";

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

// Reaction before MemberExpression so we replace reaction() as a whole first; the reaction
// replacement is self-contained (buildReactionExpression uses transformObservableMemberReads
// so inner store.count -> store.get("count")), avoiding magic-string "already been edited" errors.
const SOBX_TRANSFORMERS = [
	ObservableTransformer(),
	ReactionTransformer(),
	MemberExpressionTransformer(),
	AssignmentExpressionTransformer(),
	ImportInjectionTransformer(),
];

export type ASTPluginFactory = (opts: {
	include?: RegExp;
	exclude?: string | RegExp | (string | RegExp)[];
	transformer: unknown[];
}) => unknown;

/**
 * Creates the sobx compiler plugin for a given unplugin-ast bundler entry.
 * Use with unplugin-ast/vite, unplugin-ast/rollup, unplugin-ast/webpack, etc.
 */
export function createSobxCompiler(ast: ASTPluginFactory) {
	return function sobxCompiler(options: SobxCompilerOptions = {}) {
		const { include = /\.[jt]sx?$/, exclude } = options;
		return ast({
			include: include as RegExp,
			exclude,
			transformer: SOBX_TRANSFORMERS,
		});
	};
}
