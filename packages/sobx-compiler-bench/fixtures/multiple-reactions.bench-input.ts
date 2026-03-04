import { observable, reaction, runInAction } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// One store, two reactions; workload: N/2 writes to count, N/2 to name.
const store = observable({ count: 0, name: "" });
reaction(
	() => store.count,
	() => {},
);
reaction(
	() => store.name,
	() => {},
);
const half = Math.floor(iterations / 2);
for (let i = 0; i < half; i++) {
	runInAction(() => {
		store.count += 1;
	});
}
for (let i = 0; i < half; i++) {
	runInAction(() => {
		store.name = `n${i}`;
	});
}
