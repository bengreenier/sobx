import { observable, reaction, runInAction } from "@sobx/magic";

const store = observable({ count: 0, history: [] as number[] });
reaction(
	() => store.history.length,
	(length) => console.log("history:", length),
);
reaction(
	() => store.count,
	(count) => console.log("count:", count),
);
runInAction(() => {
	store.count += 1;
	store.history.push(store.count); // nested values are deep observables
});
