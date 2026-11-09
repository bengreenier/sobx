import { autorun, observable, reaction, runInAction } from "@sobx/magic";
import { Todos } from "./todos.js";

// A local store: compiled to a ProxyLike with explicit get/set.
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

const todos = new Todos();
autorun(() => console.log("visible:", todos.visible.join(", ")));
todos.add("write docs");
todos.add("ship it");
runInAction(() => {
	todos.filter = "ship";
});
