// Multiple features in one file: observable, reads, writes, reaction
const store = observable({ count: 0, name: "" });

function increment() {
	store.count = store.count + 1;
}

reaction(() => store.name, (name) => console.log("name:", name));
