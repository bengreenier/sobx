/**
 * Benchmark: MobX vs sobx (compiled output using ProxyLike).
 * Same workload for both: one observable store, one reaction, many write cycles.
 *
 * Run from repo root after building core: pnpm --filter @sobx/core build && pnpm --filter @sobx/compiler bench
 */

import { ProxyLike } from "@sobx/core";
import { configure, runInAction, observable, reaction } from "mobx";

configure({ enforceActions: "always" });

const ITERATIONS = 500_000;
const ROUNDS = 5;

function now(): number {
	return performance.now();
}

function runMobX(iterations: number): number {
	const state = observable({ count: 0 });
	let runs = 0;
	const dispose = reaction(
		() => state.count,
		() => {
			runs += 1;
		},
	);
	const start = now();
	for (let i = 0; i < iterations; i++) {
		runInAction(() => {
			state.count += 1;
		});
	}
	const end = now();
	dispose();
	return end - start;
}

function runSobx(iterations: number): number {
	const state = new ProxyLike({ count: 0 });
	let runs = 0;
	const disposers: { dispose: () => void }[] = [];
	disposers.push(
		state.addObserver("count", (_k, _prev, curr) => {
			runs += 1;
		}),
	);
	// Initial effect run (like compiled reaction)
	runs += 1;
	const start = now();
	for (let i = 0; i < iterations; i++) {
		state.set("count", state.get("count") + 1);
	}
	const end = now();
	disposers.forEach((d) => d.dispose());
	return end - start;
}

function median(arr: number[]): number {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 !== 0
		? sorted[mid]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Warm up
runMobX(1_000);
runSobx(1_000);

const mobxTimes: number[] = [];
const sobxTimes: number[] = [];

for (let r = 0; r < ROUNDS; r++) {
	mobxTimes.push(runMobX(ITERATIONS));
	sobxTimes.push(runSobx(ITERATIONS));
}

const mobxMed = median(mobxTimes);
const sobxMed = median(sobxTimes);
const mobxOps = (ITERATIONS / mobxMed) * 1000;
const sobxOps = (ITERATIONS / sobxMed) * 1000;

console.log("Benchmark: observable + reaction, then N writes (reaction fires each time)\n");
console.log(`  Iterations per run: ${ITERATIONS.toLocaleString()}`);
console.log(`  Rounds: ${ROUNDS} (median reported)\n`);
console.log("  MobX:");
console.log(`    Median: ${mobxMed.toFixed(2)} ms`);
console.log(`    ~${mobxOps.toLocaleString("en-US", { maximumFractionDigits: 0 })} writes/s\n`);
console.log("  sobx (ProxyLike):");
console.log(`    Median: ${sobxMed.toFixed(2)} ms`);
console.log(`    ~${sobxOps.toLocaleString("en-US", { maximumFractionDigits: 0 })} writes/s\n`);
const ratio = sobxMed / mobxMed;
const winner = ratio < 1 ? "sobx" : "MobX";
const pct = (Math.max(ratio, 1 / ratio) - 1) * 100;
console.log(`  ${winner} was ${pct.toFixed(1)}% faster in this run.\n`);
