import { autorun, observable, runInAction } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// A passed-around object used as a dictionary: keys added, deleted and enumerated.
const store = observable({ byId: {} });
const pass = (value) => value;
let total = 0;
autorun(() => {
	total += Object.keys(pass(store).byId).length;
});
for (let i = 0; i < iterations / 10; i++) {
	runInAction(() => {
		const byId = pass(store).byId;
		byId[`k${i % 20}`] = i;
		delete byId[`k${(i + 10) % 20}`];
	});
}
if (total < 0) throw new Error("unreachable");
