import * as t from "@babel/types";
import {
	type CompileDiagnostic,
	compileDiagnostics,
	type DiagnosticsConfig,
	formatDiagnostic,
} from "./diagnostics.js";
import { analyze } from "./native.js";
import {
	type CompilePlan,
	emptyPlan,
	finalizePlan,
	newRewriteState,
	RUNTIME_MODULE,
	rewrite,
} from "./plan.js";

export const DEFAULT_MODULE_SPECIFIER = "@sobx/magic";

export interface TransformSobxOptions {
	/** Module specifier to treat as sobx (only transform when imported from here). Default `"@sobx/magic"`. */
	moduleSpecifier?: string;
	/** Filename, passed to the analyzer and used in diagnostics. */
	filename?: string;
	/** Per-code severity overrides for diagnostics. */
	diagnostics?: DiagnosticsConfig;
}

/** The analysis of one module: what to rewrite, and what to report. */
export interface CompileUnit {
	plan: CompilePlan;
	diagnostics: CompileDiagnostic[];
}

/**
 * Analyze `source` with the native analyzer and plan the rewrite of `program` (parsed from
 * `source`). Sources that never mention the module specifier are skipped.
 */
export function compileUnit(
	program: t.Node,
	source: string,
	options: TransformSobxOptions = {},
): CompileUnit {
	const moduleSpecifier = options.moduleSpecifier ?? DEFAULT_MODULE_SPECIFIER;
	if (!source.includes(moduleSpecifier)) {
		return { plan: emptyPlan(moduleSpecifier), diagnostics: [] };
	}
	const mod = analyze(source, { moduleSpecifier, filename: options.filename });
	const plan = finalizePlan(mod, program, source);
	return {
		plan,
		diagnostics: compileDiagnostics(mod, plan, options.diagnostics),
	};
}

/** Thrown (by the bundler plugins) when a module has error diagnostics. */
export class SobxCompileError extends Error {
	constructor(
		readonly diagnostics: CompileDiagnostic[],
		filename?: string,
	) {
		super(
			`sobx: ${diagnostics.length} error${diagnostics.length === 1 ? "" : "s"}:\n${diagnostics
				.map((d) => `  ${formatDiagnostic(d, filename)}`)
				.join("\n")}`,
		);
		this.name = "SobxCompileError";
	}
}

/**
 * Compile a program. Imports from the API module are redirected to `@sobx/runtime`, which
 * implements it; local `observable({...})` objects whose every use can be rewritten become a
 * `ProxyLike` with explicit `get` / `set` calls. `source` must be the text `program` was parsed
 * from (nodes are matched to the analysis by offset). `program` is not mutated.
 *
 * Returns the diagnostics rather than throwing; check for `severity: "error"`.
 */
export function transformSobx(
	program: t.Program,
	source: string,
	options: TransformSobxOptions = {},
): {
	ast: t.Program;
	diagnostics: CompileDiagnostic[];
	needsProxyLike: boolean;
} {
	const { plan, diagnostics } = compileUnit(program, source, options);
	const state = newRewriteState();
	const ast = rewrite(program, plan, state) as t.Program;
	return {
		ast: state.needsProxyLike ? injectProxyLike(ast, plan.proxyName) : ast,
		diagnostics,
		needsProxyLike: state.needsProxyLike,
	};
}

/** `import { ProxyLike } from "@sobx/runtime";` (aliased if the name is taken). */
export function proxyLikeImport(name: string): string {
	return name === "ProxyLike"
		? `import { ProxyLike } from "${RUNTIME_MODULE}";`
		: `import { ProxyLike as ${name} } from "${RUNTIME_MODULE}";`;
}

/** Add the `ProxyLike` import after the program's existing imports. */
function injectProxyLike(program: t.Program, name: string): t.Program {
	const declaration = t.importDeclaration(
		[t.importSpecifier(t.identifier(name), t.identifier("ProxyLike"))],
		t.stringLiteral(RUNTIME_MODULE),
	);
	const body = [...program.body];
	let index = 0;
	while (index < body.length && t.isImportDeclaration(body[index])) index++;
	body.splice(index, 0, declaration);
	return t.program(body, program.directives, program.sourceType);
}
