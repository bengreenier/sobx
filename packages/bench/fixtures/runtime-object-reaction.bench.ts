import { observable, reaction, runInAction } from "mobx";

/** Injected by the bench runner at runtime. */
declare const iterations: number;

// An observable passed around (so not compiled to the ProxyLike fast path): an accessor-based
// object at runtime, behind a Proxy with configure({ useProxies: "always" }).
const store = observable({ count: 0, items: [0] });
const pass = (value) => value;
pass(store);
reaction(
	() => store.count + store.items.length,
	() => {},
);
for (let i = 0; i < iterations; i++) {
	runInAction(() => {
		store.count = i;
		if (i % 100 === 0) store.items.push(i);
	});
}
