import { autorun, observable, runInAction } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// Like rendering a list: a store that is passed around (so it's behind a Proxy at runtime), with
// an array of objects read by index inside a derivation, re-run by each change.
const store = observable({ items: [] });
const pass = (value) => value;
for (let i = 0; i < 50; i++) store.items.push({ id: i, name: "x", done: false });
function render(s) {
	let out = 0;
	for (let i = 0; i < s.items.length; i++) {
		const { id, done } = s.items[i];
		out += done ? id : s.items[i].name.length;
	}
	return out;
}
let total = 0;
autorun(() => {
	total += render(pass(store));
});
for (let i = 0; i < iterations / 100; i++) {
	runInAction(() => {
		const item = pass(store).items[i % 50];
		item.done = !item.done;
	});
}
if (total < 0) throw new Error("unreachable");
