// SPIKE benchmark: Babel analyzer (dist) vs the Rust analyzer (napi). Not part of the package.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze as babelAnalyze } from "../dist/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const native = createRequire(import.meta.url)(
	path.join(here, "..", "..", "ast-native", "sobx-ast-native.node"),
);

function median(fn, runs = 40, warmup = 8) {
	for (let i = 0; i < warmup; i++) fn();
	const times = [];
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		fn();
		times.push(performance.now() - t);
	}
	times.sort((a, b) => a - b);
	return times[Math.floor(times.length / 2)];
}

// A MobX-heavy module: many stores, accesses, and reactions.
function generate(stores) {
	const lines = ['import { observable, reaction, autorun } from "sobx";'];
	for (let i = 0; i < stores; i++) {
		lines.push(
			`const s${i} = observable({ count: 0, name: "n${i}", items: [], nested: { x: 1 } });`,
			`function bump${i}() { s${i}.count += 1; s${i}.items.push(s${i}.count); }`,
			`reaction(() => s${i}.count + s${i}.nested.x, (v) => console.log(v, s${i}.name));`,
			`autorun(() => { const { name, count } = s${i}; console.log(name, count); });`,
		);
	}
	return lines.join("\n");
}

const inputs = {
	"analyze.ts (2.7k lines, little MobX)": readFileSync(
		path.join(here, "..", "src", "analyze.ts"),
		"utf-8",
	),
	"generated (2k lines, all MobX)": generate(500),
};

for (const [name, src] of Object.entries(inputs)) {
	const b = median(() => babelAnalyze(src));
	const r = median(() => JSON.parse(native.analyze(src)));
	const rNoParse = median(() => native.analyze(src));
	const bm = babelAnalyze(src);
	const rm = JSON.parse(native.analyze(src));
	console.log(`${name}:`);
	console.log(`  babel analyze()            ${b.toFixed(2)}ms`);
	console.log(
		`  rust analyze + JSON.parse  ${r.toFixed(2)}ms  (${(b / r).toFixed(1)}x)`,
	);
	console.log(`  rust analyze (string only) ${rNoParse.toFixed(2)}ms`);
	console.log(
		`  accesses: babel ${bm.accesses.length}, rust ${rm.accesses.length}; diagnostics: babel ${bm.diagnostics.length}, rust ${rm.diagnostics.length}`,
	);
}
