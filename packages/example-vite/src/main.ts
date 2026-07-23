import { observable, reaction, runInAction } from "sobx";

const store = observable({ count: 0 });
reaction(
	() => store.count,
	(count) => {
		// biome-ignore lint/style/noNonNullAssertion: app root is guaranteed in index.html
		document.getElementById("app")!.textContent = `Count: ${count}`;
	},
);
runInAction(() => {
	store.count = store.count + 1;
});
