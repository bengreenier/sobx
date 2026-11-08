import { observable, reaction } from "@sobx/magic";

const store = observable({ count: 0 });
reaction(
	() => store.count,
	(count) => console.log("count:", count),
);
store.count += 1;
