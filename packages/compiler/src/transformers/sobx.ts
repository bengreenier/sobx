import * as t from "@babel/types";
import { babelParse, getLang } from "ast-kit";
import type { Transformer } from "unplugin-ast";
import type { DiagnosticsConfig } from "../diagnostics.js";
import { formatDiagnostic } from "../diagnostics.js";
import {
	type CompilePlan,
	newRewriteState,
	type RewriteState,
	rewriteMatch,
} from "../plan.js";
import {
	compileUnit,
	DEFAULT_MODULE_SPECIFIER,
	proxyLikeImport,
	SobxCompileError,
} from "../transform.js";

/**
 * Babel parser plugins for sobx sources: auto-accessors (`@observable accessor x`), on top of
 * the decorator syntax ast-kit enables by default for TypeScript, which also accepts parameter
 * decorators (as used by NestJS / Angular) in files that do not use sobx.
 */
export const PARSER_PLUGINS = [
	"decorators-legacy",
	"decoratorAutoAccessors",
] as const;

export interface SobxTransformerOptions {
	moduleSpecifier?: string;
	/** Per-code severity overrides for diagnostics. */
	diagnostics?: DiagnosticsConfig;
	/** Where warnings go. Default `console.warn`. */
	warn?: (message: string) => void;
}

interface FileState extends RewriteState {
	code: string;
	plan: CompilePlan;
	/** Spans already replaced; nodes inside them were rewritten along with them. */
	replaced: Array<[number, number]>;
}

/**
 * unplugin-ast transformer that compiles sobx usages. Each file is analyzed once (native
 * analyzer, plus a Babel parse to validate the plan); nodes are then rewritten when their span
 * matches the plan. unplugin-ast visits nodes outermost-first, and a replaced node already
 * contains its rewritten children, so nodes inside a replaced span are skipped.
 *
 * Error diagnostics fail the transform (with every error listed); warnings are logged.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function SobxTransformer(options: SobxTransformerOptions | string = {}) {
	const {
		moduleSpecifier = DEFAULT_MODULE_SPECIFIER,
		diagnostics,
		warn = console.warn,
	} = typeof options === "string" ? { moduleSpecifier: options } : options;
	// Per-file state, keyed by module id.
	const files = new Map<string, FileState>();
	const stateFor = (code: string, id: string): FileState => {
		let state = files.get(id);
		if (state?.code !== code) {
			const program = code.includes(moduleSpecifier)
				? babelParse(code, getLang(id), { plugins: [...PARSER_PLUGINS] })
				: t.program([]);
			const unit = compileUnit(program, code, {
				moduleSpecifier,
				filename: id,
				diagnostics,
			});
			const errors = unit.diagnostics.filter((d) => d.severity === "error");
			if (errors.length > 0) throw new SobxCompileError(errors, id);
			for (const d of unit.diagnostics) {
				if (d.severity === "warning") warn(`sobx: ${formatDiagnostic(d, id)}`);
			}
			state = { ...newRewriteState(), code, plan: unit.plan, replaced: [] };
			files.set(id, state);
		}
		return state;
	};

	return {
		onNode(node: t.Node): boolean {
			return (
				t.isImportDeclaration(node) ||
				t.isExportNamedDeclaration(node) ||
				t.isExportAllDeclaration(node) ||
				t.isCallExpression(node) ||
				t.isOptionalCallExpression(node) ||
				t.isMemberExpression(node) ||
				t.isOptionalMemberExpression(node) ||
				t.isAssignmentExpression(node) ||
				t.isUpdateExpression(node) ||
				t.isUnaryExpression(node) ||
				t.isVariableDeclarator(node)
			);
		},

		transform(node: t.Node, code: string, context: { id: string }) {
			const state = stateFor(code, context.id);
			const { start, end } = node;
			if (start == null || end == null) return undefined;
			if (state.replaced.some(([s, e]) => start >= s && end <= e))
				return undefined;
			const replacement = rewriteMatch(node, state.plan, state);
			if (!replacement) return undefined;
			state.replaced.push([start, end]);
			return replacement;
		},

		finalize(s: { original: string; prepend(content: string): unknown }) {
			// finalize gets no module id; any state for this exact source has the same plan.
			let state: FileState | undefined;
			for (const [id, candidate] of files) {
				if (candidate.code !== s.original) continue;
				state = candidate;
				files.delete(id);
				break;
			}
			if (state?.needsProxyLike) {
				s.prepend(`${proxyLikeImport(state.plan.proxyName)}\n`);
			}
		},
		// biome-ignore lint/suspicious/noExplicitAny: unplugin-ast's Node type comes from its own @babel/types copy
	} as Transformer<any>;
}
