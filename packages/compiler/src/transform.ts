import * as t from "@babel/types";
import { analyze } from "./native.js";
import {
	type CompilePlan,
	emptyPlan,
	planFromModule,
	rewrite,
} from "./plan.js";

const SOBX_RUNTIME = "@sobx/runtime";
const PROXY_LIKE = "ProxyLike";

export const DEFAULT_MODULE_SPECIFIER = "@sobx/magic";

export interface TransformSobxOptions {
	/** Module specifier to treat as sobx (only transform when imported from here). Default `"@sobx/magic"`. */
	moduleSpecifier?: string;
	/** Filename, passed to the analyzer. */
	filename?: string;
}

/**
 * Analyze `source` with the native analyzer and build the plan of what to rewrite. Skips the
 * analyzer for sources that never mention the module specifier.
 */
export function planSource(
	source: string,
	options: TransformSobxOptions = {},
): CompilePlan {
	const moduleSpecifier = options.moduleSpecifier ?? DEFAULT_MODULE_SPECIFIER;
	if (!source.includes(moduleSpecifier)) return emptyPlan();
	return planFromModule(
		analyze(source, { moduleSpecifier, filename: options.filename }),
	);
}

/**
 * Compile a program: `observable()` -> `new ProxyLike()`, property reads / writes on those
 * observables -> `.get()` / `.set()`, and `reaction()` -> explicit observers. What to rewrite
 * comes from the native analyzer, so `source` must be the text `program` was parsed from
 * (node offsets are matched against the analyzer's spans). `program` is not mutated.
 */
export function transformSobx(
	program: t.Program,
	source: string,
	options: TransformSobxOptions = {},
): {
	ast: t.Program;
	needsProxyLike: boolean;
	needsReaction: boolean;
} {
	const plan = planSource(source, options);
	const state = { needsProxyLike: false, needsReaction: false };
	const ast = rewrite(program, plan, state) as t.Program;
	const finalAst = ensureImports(ast, {
		proxyLike: state.needsProxyLike,
		reaction: state.needsReaction,
	});
	return { ast: finalAst, ...state };
}

/**
 * Ensure the program has the necessary imports from @sobx/runtime.
 */
export function ensureImports(
	program: t.Program,
	opts: { proxyLike: boolean; reaction: boolean },
): t.Program {
	const specifiers: t.ImportSpecifier[] = [];
	if (opts.proxyLike) {
		specifiers.push(
			t.importSpecifier(t.identifier(PROXY_LIKE), t.identifier(PROXY_LIKE)),
		);
	}
	// Compiled reactions need no runtime import.

	if (specifiers.length === 0) return program;

	const importDecl = t.importDeclaration(
		specifiers,
		t.stringLiteral(SOBX_RUNTIME),
	);

	const body = [...program.body];
	// Insert after existing imports
	let insertIndex = 0;
	for (let i = 0; i < body.length; i++) {
		if (t.isImportDeclaration(body[i])) {
			insertIndex = i + 1;
		} else {
			break;
		}
	}
	body.splice(insertIndex, 0, importDecl);

	return t.program(body, program.directives);
}
