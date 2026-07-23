import { AssignmentExpressionTransformer } from "./transformers/assignment-expression.js";
import { ImportInjectionTransformer } from "./transformers/import-injection.js";
import { MemberExpressionTransformer } from "./transformers/member-expression.js";
import { ObservableTransformer } from "./transformers/observable.js";
import { ReactionTransformer } from "./transformers/reaction.js";

const DEFAULT_INCLUDE = /\.[jt]sx?$/;
/** Skip dependency sources — Babel-parsing node_modules dominates bundler time. */
const DEFAULT_EXCLUDE = /node_modules/;

export interface SobxCompilerOptions {
	/**
	 * Include pattern for files to transform (default: /\.[jt]sx?$/).
	 */
	include?: string | RegExp | (string | RegExp)[];
	/**
	 * Exclude pattern(s) to skip. Always merged with `/node_modules/`.
	 */
	exclude?: string | RegExp | (string | RegExp)[];
	/**
	 * Module specifier to treat as sobx (only transform when imported from here). Default `"sobx"`.
	 */
	moduleSpecifier?: string;
}

export type ASTPluginFactory = (opts: {
	include?: RegExp;
	exclude?: string | RegExp | (string | RegExp)[];
	transformer: unknown[];
}) => unknown;

function mergeExclude(
	exclude?: string | RegExp | (string | RegExp)[],
): string | RegExp | (string | RegExp)[] {
	if (exclude == null) return DEFAULT_EXCLUDE;
	const extras = Array.isArray(exclude) ? exclude : [exclude];
	return [...extras, DEFAULT_EXCLUDE];
}

// Reaction before MemberExpression so we replace reaction() as a whole first; the reaction
// replacement is self-contained (buildReactionExpression uses transformObservableMemberReads
// so inner store.count -> store.get("count")), avoiding magic-string "already been edited" errors.
function createTransformers(moduleSpecifier: string) {
	return [
		ObservableTransformer(moduleSpecifier),
		ReactionTransformer(moduleSpecifier),
		MemberExpressionTransformer(moduleSpecifier),
		AssignmentExpressionTransformer(moduleSpecifier),
		ImportInjectionTransformer(),
	];
}

/**
 * Creates the sobx compiler plugin for a given unplugin-ast bundler entry.
 * Use with unplugin-ast/vite, unplugin-ast/rollup, unplugin-ast/webpack, etc.
 */
export function createSobxCompiler(ast: ASTPluginFactory) {
	return function sobxCompiler(options: SobxCompilerOptions = {}) {
		const {
			include = DEFAULT_INCLUDE,
			exclude,
			moduleSpecifier = "sobx",
		} = options;
		return ast({
			include: include as RegExp,
			exclude: mergeExclude(exclude),
			transformer: createTransformers(moduleSpecifier),
		});
	};
}
