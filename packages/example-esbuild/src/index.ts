import { autorun, observable, reaction } from "@sobx/magic";
import { Todos } from "./todos.js";

// A local store: compiled to a ProxyLike with explicit get/set.
const store = observable({ count: 0 });
reaction(
	() => store.count,
	(count) => console.log("count:", count),
);
store.count += 1;

const todos = new Todos();
autorun(() => console.log("visible:", todos.visible.join(", ")));
todos.add("write docs");
todos.add("ship it");
todos.filter = "ship";
