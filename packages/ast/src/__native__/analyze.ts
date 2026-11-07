/**
 * Test shim: the Rust analyzer (packages/ast-native) behind the same `analyze()` signature
 * as the Babel analyzer, so the existing specs can run against it unchanged. Used only by
 * the `native` vitest project. Not part of the package.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { analyze as babelAnalyze } from "../analyze.js";
import type { SobxModule } from "../types.js";

const addon = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"ast-native",
	"sobx-ast-native.node",
);
const native = createRequire(import.meta.url)(addon) as {
	analyze(source: string, moduleSpecifier?: string, filename?: string): string;
};

export const DEFAULT_MODULE_SPECIFIER = "sobx";

export interface AnalyzeOptions {
	moduleSpecifier?: string;
	filename?: string;
}

/**
 * Runs the Rust analyzer, and also checks its complete output against the Babel analyzer:
 * every input the specs use doubles as a full-IR equivalence check.
 */
export function analyze(
	source: string,
	options: AnalyzeOptions = {},
): SobxModule {
	const attempt = <T>(fn: () => T): { value?: T; error?: Error } => {
		try {
			return { value: fn() };
		} catch (error) {
			return { error: error as Error };
		}
	};
	const r = attempt(
		() =>
			JSON.parse(
				native.analyze(source, options.moduleSpecifier, options.filename),
			) as SobxModule,
	);
	const b = attempt(
		() =>
			JSON.parse(JSON.stringify(babelAnalyze(source, options))) as SobxModule,
	);
	// Both must reject the same inputs (e.g. syntax errors).
	if (r.error || b.error) {
		if (r.error && b.error) throw b.error;
		throw new Error(
			r.error
				? `Rust analyzer threw but Babel did not: ${r.error.message}`
				: `Babel analyzer threw but Rust did not: ${b.error?.message}`,
		);
	}
	const rust = r.value as SobxModule;
	const babel = b.value as SobxModule;
	if (!isDeepStrictEqual(rust, babel)) {
		const keys = Object.keys(babel) as Array<keyof SobxModule>;
		const diff = keys.filter(
			(key) => !isDeepStrictEqual(rust[key], babel[key]),
		);
		const details = diff.map((key) => {
			const a = rust[key] as unknown;
			const b = babel[key] as unknown;
			if (Array.isArray(a) && Array.isArray(b)) {
				// Report the first differing element, with the source text at its span.
				const i = Array.from({
					length: Math.max(a.length, b.length),
				}).findIndex((_, j) => !isDeepStrictEqual(a[j], b[j]));
				const span = (b[i] ?? a[i])?.span as { start: number; end: number };
				const text = span ? source.slice(span.start, span.end) : "";
				return `--- ${key}[${i}] (lengths rust ${a.length}, babel ${b.length}) at ${JSON.stringify(text)}\nrust:  ${JSON.stringify(a[i])}\nbabel: ${JSON.stringify(b[i])}`;
			}
			return `--- ${key}\nrust:  ${JSON.stringify(a)}\nbabel: ${JSON.stringify(b)}`;
		});
		throw new Error(
			`Rust and Babel analyzers differ in ${diff.join(", ")}:\n${details.join("\n")}`,
		);
	}
	return rust;
}
