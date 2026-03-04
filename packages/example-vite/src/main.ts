import { observable, reaction } from "mobx";

const store = observable({ count: 0 });
reaction(
	() => store.count,
	(count) => {
		document.getElementById("app")!.textContent = `Count: ${count}`;
	},
);
store.count += 1;
