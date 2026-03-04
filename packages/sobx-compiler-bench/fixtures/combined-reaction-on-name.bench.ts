import { observable, reaction, runInAction } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// Store with count and name, reaction on name only; workload: N writes to name.
const store = observable({ count: 0, name: "" });
reaction(() => store.name, () => {});
for (let i = 0; i < iterations; i++) {
	runInAction(() => {
		store.name = "n" + i;
	});
}
