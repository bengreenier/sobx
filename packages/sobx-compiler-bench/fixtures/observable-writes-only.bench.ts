import { observable, runInAction } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// Observable only, no reaction; workload: N writes to count.
const state = observable({ count: 0 });
for (let i = 0; i < iterations; i++) {
	runInAction(() => {
		state.count += 1;
	});
}
