import { observable, reaction, runInAction } from "@sobx/magic";

const store = observable({ count: 0, history: [] as number[] });
reaction(
	() => store.history.length,
	(length) => console.log("history:", length),
);
reaction(
	() => store.count,
	(count) => {
		// biome-ignore lint/style/noNonNullAssertion: app root is guaranteed in index.html
		document.getElementById("app")!.textContent = `Count: ${count}`;
	},
);
runInAction(() => {
	store.count += 1;
	store.history.push(store.count); // nested values are deep observables
});
