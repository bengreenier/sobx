import { observable, reaction, runInAction } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// One reaction on value (sync-to-external pattern); workload: N writes to value.
const state = observable({ value: "" });
reaction(() => state.value, () => {});
for (let i = 0; i < iterations; i++) {
	runInAction(() => {
		state.value = "v" + i;
	});
}
