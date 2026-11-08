import { observable, reaction, runInAction } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// Counter with one reaction; workload: N increments (reaction fires each time).
const counter = observable({ count: 0 });
reaction(
	() => counter.count,
	() => {},
);
for (let i = 0; i < iterations; i++) {
	runInAction(() => {
		counter.count += 1;
	});
}
