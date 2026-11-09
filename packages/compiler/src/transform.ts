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
	helperName,
	newRewriteState,
	type RewriteState,
	RUNTIME_MODULE,
	rewrite,
} from "./plan.js";

export const DEFAULT_MODULE_SPECIFIER = "@sobx/magic";
/** The React bindings: modules using them are compiled too (their hooks create observables). */
export const REACT_MODULE = "@sobx/react";

export interface TransformSobxOptions {
	/** Module specifier to treat as sobx. Default `"@sobx/magic"`. Only modules that import it (or `"@sobx/react"`) are transformed. */
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
	if (!source.includes(moduleSpecifier) && !source.includes(REACT_MODULE)) {
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
		ast: injectRuntimeImports(ast, plan, state),
		diagnostics,
		needsProxyLike: state.needsProxyLike,
	};
}

/** The runtime bindings the rewritten code uses: `[imported, local]` pairs. */
function runtimeBindings(
	plan: CompilePlan,
	state: RewriteState,
): Array<[string, string]> {
	const bindings: Array<[string, string]> = [];
	if (state.needsProxyLike) bindings.push(["ProxyLike", plan.proxyName]);
	for (const name of [...state.helpers].sort()) {
		bindings.push([name, helperName(name)]);
	}
	return bindings;
}

/**
 * The `import { ... } from "@sobx/runtime";` the rewritten code needs (`ProxyLike`, helpers),
 * or `undefined` if it needs none.
 */
export function runtimeImport(
	plan: CompilePlan,
	state: RewriteState,
): string | undefined {
	const bindings = runtimeBindings(plan, state);
	if (bindings.length === 0) return undefined;
	const specifiers = bindings
		.map(([imported, local]) =>
			imported === local ? imported : `${imported} as ${local}`,
		)
		.join(", ");
	return `import { ${specifiers} } from "${RUNTIME_MODULE}";`;
}

/** Add the runtime import after the program's existing imports. */
function injectRuntimeImports(
	program: t.Program,
	plan: CompilePlan,
	state: RewriteState,
): t.Program {
	const bindings = runtimeBindings(plan, state);
	if (bindings.length === 0) return program;
	const declaration = t.importDeclaration(
		bindings.map(([imported, local]) =>
			t.importSpecifier(t.identifier(local), t.identifier(imported)),
		),
		t.stringLiteral(RUNTIME_MODULE),
	);
	const body = [...program.body];
	let index = 0;
	while (index < body.length && t.isImportDeclaration(body[index])) index++;
	body.splice(index, 0, declaration);
	return t.program(body, program.directives, program.sourceType);
}
