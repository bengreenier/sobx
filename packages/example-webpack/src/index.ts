import { observable, reaction, runInAction } from "sobx";

const store = observable({ count: 0 });
reaction(
	() => store.count,
	(count) => console.log("count:", count),
);
runInAction(() => {
	store.count = store.count + 1;
});
