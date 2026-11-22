/**
 * Benchmark: MobX vs sobx (compiled output using ProxyLike).
 * Runs each *.bench.ts in node:vm; each script sets up store/reactions and
 * runs a workload loop using the global `iterations` (injected by this runner).
 * We time full script execution.
 *
 * Run from repo root (build core and compiler first):
 *   pnpm --filter @sobx/runtime build && pnpm --filter @sobx/compiler build && pnpm --filter @sobx/bench bench
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import { transformSobx } from "@sobx/compiler";
import * as sobxRuntime from "@sobx/runtime";
import { autorun, configure, observable, reaction, runInAction } from "mobx";

configure({ enforceActions: "always" });
// SOBX_NO_PROXIES=1: sobx with configure({ useProxies: "never" }).
if (process.env.SOBX_NO_PROXIES) sobxRuntime.configure({ useProxies: "never" });

const ITERATIONS = 500_000;
const ROUNDS = 5;
const WARMUP = 1_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

function now(): number {
	return performance.now();
}

function median(arr: number[]): number {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const a = sorted[mid];
	const b = sorted[mid - 1];
	if (a === undefined) return 0;
	if (sorted.length % 2 !== 0) return a;
	return b !== undefined ? (a + b) / 2 : a;
}

function listBenchInputs(): string[] {
	return readdirSync(FIXTURES_DIR)
		.filter((f) => f.endsWith(".bench.ts"))
		.map((f) => f.replace(/\.bench\.ts$/, ""))
		.sort();
}

function loadBenchSource(basename: string): string {
	const p = path.join(FIXTURES_DIR, `${basename}.bench.ts`);
	return readFileSync(p, "utf-8");
}

function compileToSobx(source: string): string {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	const { ast: transformed } = transformSobx(ast.program, source, {
		moduleSpecifier: "mobx",
	});
	const gen =
		"default" in generate &&
		typeof (generate as { default: unknown }).default === "function"
			? (generate as { default: (ast: unknown) => { code: string } }).default
			: generate;
	return gen(transformed).code;
}

/** Remove ESM import of mobx so we can run in vm with globals in context. */
function stripMobxImport(code: string): string {
	return code.replace(/import\s*\{[^}]*\}\s*from\s*["']mobx["'];?\s*\n?/g, "");
}

/** Remove TypeScript declare for iterations (vm runs JS, not TS). */
function stripDeclareIterations(code: string): string {
	return code.replace(
		/(?:\/\*\*[^*]*\*\*\/\s*\n?\s*)?declare\s+const\s+iterations\s*:\s*number\s*;?\s*\n?/g,
		"",
	);
}

/** Remove ESM imports of @sobx/runtime so we can run in vm with the runtime in context. */
function stripSobxImport(code: string): string {
	return code.replace(
		/import\s*\{[^}]*\}\s*from\s*["']@sobx\/runtime["'];?\s*\n?/g,
		"",
	);
}

/**
 * Run `code` in a fresh `node:vm` context, with `bindings` as parameters of a wrapping function:
 * local bindings, like a module's imports (globals of a vm context are much slower to read).
 * Returns the time `code` took.
 */
function runScript(code: string, bindings: Record<string, unknown>): number {
	const names = Object.keys(bindings);
	const fn = vm.runInNewContext(
		`(function (${names.join(", ")}) {
${code}
})`,
		{},
	) as (...args: unknown[]) => void;
	const start = now();
	fn(...names.map((name) => bindings[name]));
	return now() - start;
}

function runMobX(basename: string, iterations: number): number {
	const source = stripDeclareIterations(
		stripMobxImport(loadBenchSource(basename)),
	);
	return runScript(source, {
		autorun,
		observable,
		reaction,
		runInAction,
		console: { log: () => {} },
		iterations,
	});
}

/** The bindings the compiled code imports from @sobx/runtime (`{ a, b as c }`), by local name. */
function runtimeImports(code: string): Record<string, unknown> {
	const runtime = sobxRuntime as Record<string, unknown>;
	const bindings: Record<string, unknown> = {};
	for (const [, list] of code.matchAll(
		/import\s*\{([^}]*)\}\s*from\s*["']@sobx\/runtime["']/g,
	)) {
		for (const specifier of (list as string).split(",")) {
			const [imported, local = imported] = specifier.trim().split(/\s+as\s+/);
			if (imported) bindings[local as string] = runtime[imported];
		}
	}
	return bindings;
}

function runSobx(basename: string, iterations: number): number {
	const source = loadBenchSource(basename);
	const compiled = compileToSobx(source);
	const code = stripDeclareIterations(
		stripSobxImport(stripMobxImport(compiled)),
	);
	return runScript(code, {
		...runtimeImports(compiled),
		console: { log: () => {} },
		iterations,
	});
}

const benchNames = listBenchInputs();
if (benchNames.length === 0) {
	console.error("No *.bench.ts files found in", FIXTURES_DIR);
	process.exit(1);
}

// Warm up each bench once
for (const name of benchNames) {
	runMobX(name, WARMUP);
	runSobx(name, WARMUP);
}

console.log(
	"Benchmark: MobX vs sobx (ProxyLike), NODE_ENV=production, enforceActions: always\n",
);
console.log("  Each *.bench.ts runs in node:vm (setup + workload loop).\n");
console.log(`  iterations (global): ${ITERATIONS.toLocaleString()}`);
console.log(`  Rounds per bench: ${ROUNDS} (median reported)\n`);

for (const name of benchNames) {
	const mobxTimes: number[] = [];
	const sobxTimes: number[] = [];
	for (let r = 0; r < ROUNDS; r++) {
		mobxTimes.push(runMobX(name, ITERATIONS));
		sobxTimes.push(runSobx(name, ITERATIONS));
	}
	const mobxMed = median(mobxTimes);
	const sobxMed = median(sobxTimes);
	const mobxOps = (ITERATIONS / mobxMed) * 1000;
	const sobxOps = (ITERATIONS / sobxMed) * 1000;
	const ratio = sobxMed / mobxMed;
	const winner = ratio < 1 ? "sobx" : "MobX";
	const pct = (Math.max(ratio, 1 / ratio) - 1) * 100;
	console.log(`  [${name}]`);
	console.log(
		`    MobX:  ${mobxMed.toFixed(2)} ms  ~${mobxOps.toLocaleString("en-US", { maximumFractionDigits: 0 })} ops/s`,
	);
	console.log(
		`    sobx:  ${sobxMed.toFixed(2)} ms  ~${sobxOps.toLocaleString("en-US", { maximumFractionDigits: 0 })} ops/s`,
	);
	console.log(`    ${winner} ${pct.toFixed(1)}% faster\n`);
}
