import type { DiagnosticCode, Options, SobxModule, Span } from "@sobx/ast";
import type { CompilePlan } from "./plan.js";

/** Codes the compiler adds on top of the analyzer's. */
export type CompilerDiagnosticCode =
	/** An option the runtime doesn't implement. */
	| "unsupported-option"
	/** An observable left to the runtime (accessor-based) instead of the `ProxyLike` fast path. */
	| "runtime-observable";

export type CompileDiagnosticCode = DiagnosticCode | CompilerDiagnosticCode;
export type CompileSeverity = "error" | "warning" | "info";

export interface CompileDiagnostic {
	code: CompileDiagnosticCode;
	severity: CompileSeverity;
	message: string;
	span: Span;
}

/** Per-code severity overrides; `"off"` drops the diagnostic. */
export type DiagnosticsConfig = Partial<
	Record<CompileDiagnosticCode, CompileSeverity | "off">
>;

/**
 * Default severity of each code when compiling. The runtime implements the API, so most of
 * what the analyzer can't model still works (it just doesn't get the fast path). Errors are
 * what would behave differently from MobX or fail at runtime.
 */
export const DEFAULT_SEVERITY: Record<CompileDiagnosticCode, CompileSeverity> =
	{
		// Would fail or behave differently at runtime.
		"unknown-import": "error",
		"default-import": "error",
		"unsupported-api": "error",
		"invalid-arguments": "error",
		"deep-mutation": "error",
		"observable-collection": "error",
		"invalid-annotation": "error",
		"unknown-annotation-key": "error",
		"missing-annotations": "error",
		"unsupported-option": "error",
		// Probably mistakes, as in MobX.
		"write-in-derivation": "warning",
		"after-await": "warning",
		// Handled by the runtime.
		"namespace-import": "info",
		"api-not-called": "info",
		"unbound-observable": "info",
		"observable-escape": "info",
		"dynamic-key": "info",
		"unsupported-operation": "info",
		"opaque-function": "info",
		"observable-reassigned": "info",
		"untracked-nested-read": "info",
		"unsupported-target": "info",
		"make-observable-outside-constructor": "info",
		"unresolved-import": "info",
		"runtime-observable": "info",
		"opaque-observable": "info",
	};

/** Options the runtime implements, per API. */
const SUPPORTED_OPTIONS = {
	reaction: ["fireImmediately", "equals", "name"],
	autorun: ["name"],
	when: ["timeout", "name"],
	computed: ["equals", "name", "keepAlive"],
	observable: ["autoBind", "deep", "name", "proxy"],
	"observable.box": ["equals", "deep", "name"],
	"observable.map": ["deep", "name"],
	"observable.set": ["deep", "name"],
} as const;

const SPECIFIC_MESSAGES: Partial<Record<CompileDiagnosticCode, string>> = {
	"deep-mutation":
		"sobx observables are shallow: mutating a nested object or array is not observed. Replace the value instead (e.g. `store.items = [...store.items, item]`).",
};

/** The compile diagnostics for a module: the analyzer's, re-graded, plus the compiler's own. */
export function compileDiagnostics(
	mod: SobxModule,
	plan: CompilePlan,
	config: DiagnosticsConfig = {},
): CompileDiagnostic[] {
	const out: CompileDiagnostic[] = [];
	const push = (code: CompileDiagnosticCode, message: string, span: Span) => {
		const severity = config[code] ?? DEFAULT_SEVERITY[code];
		if (severity === "off") return;
		out.push({ code, severity, message, span });
	};

	for (const d of mod.diagnostics) {
		const extra = SPECIFIC_MESSAGES[d.code];
		push(d.code, extra ? `${d.message} ${extra}` : d.message, d.span);
	}

	const checkOptions = (
		api: keyof typeof SUPPORTED_OPTIONS,
		options: Options | null,
		span: Span,
	) => {
		if (options?.kind !== "object") return;
		const supported: readonly string[] = SUPPORTED_OPTIONS[api];
		for (const key of Object.keys(options.entries)) {
			if (!supported.includes(key)) {
				push(
					"unsupported-option",
					`The "${key}" option of ${api}() is not supported by @sobx/runtime.`,
					span,
				);
			}
		}
	};
	for (const r of mod.reactions) checkOptions(r.api, r.options, r.span);
	for (const c of mod.computeds) checkOptions("computed", c.options, c.span);
	for (const o of mod.observables) {
		const kind = o.shape.kind;
		checkOptions(
			kind === "box" || kind === "map" || kind === "set"
				? `observable.${kind}`
				: "observable",
			o.options,
			o.span,
		);
	}

	for (const o of mod.observables) {
		const reason = plan.fallbacks.get(o.id);
		if (reason && o.target === "object" && o.source === "observable") {
			push(
				"runtime-observable",
				`Not compiled to the ProxyLike fast path (${reason}); made observable at runtime instead.`,
				o.span,
			);
		}
	}

	return out.sort((a, b) => a.span.start - b.span.start);
}

/** `file:line:col - severity code: message`. */
export function formatDiagnostic(
	d: CompileDiagnostic,
	filename = "<input>",
): string {
	const { line, column } = d.span.loc.start;
	return `${filename}:${line}:${column + 1} - ${d.severity} ${d.code}: ${d.message}`;
}
