import { autorun, observable } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// Plain data, no observables: the compiler must leave this code alone, so both columns are plain
// JavaScript (neither library does anything) inside a derivation.
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
	return shape.width * shape.height + shape.border.size + shape.matrix[1][0];
}
const shape = { width: 2, height: 3, border: { size: 1 }, matrix: [[1], [2]] };
const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const counts = {};
const keys = ["a", "b", "c", "d"];
autorun(() => {
	let checksum = 0;
	for (let i = 0; i < iterations; i++) {
		checksum += sum(values);
		tally(counts, keys[i % 4]);
		checksum += size(counts);
		checksum += area(shape);
	}
	if (checksum < 0) throw new Error("unreachable");
});
