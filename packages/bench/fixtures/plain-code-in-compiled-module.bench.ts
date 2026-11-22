import { observable } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// Plain data handled through parameters, in a module the compiler processes: sobx rewrites the
// property and index / length reads, dynamic-key writes and Object.keys (the values could be observables), so
// this measures what that costs on plain values. No observables are involved.
observable({ unused: 0 });
function sum(values) {
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i];
	return total;
}
function tally(counts, key) {
	counts[key] = (counts[key] ?? 0) + 1;
}
function size(counts) {
	return Object.keys(counts).length;
}
function area(shape) {
	return shape.width * shape.height + shape.border.size;
}
const shape = { width: 2, height: 3, border: { size: 1 } };
const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const counts = {};
const keys = ["a", "b", "c", "d"];
let checksum = 0;
for (let i = 0; i < iterations; i++) {
	checksum += sum(values);
	tally(counts, keys[i % 4]);
	checksum += size(counts);
	checksum += area(shape);
}
if (checksum < 0) throw new Error("unreachable");
