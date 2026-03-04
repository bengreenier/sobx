// One store, multiple reactions (common MobX pattern)
const store = observable({ count: 0, name: "" });
reaction(() => store.count, (n) => console.log("count:", n));
reaction(() => store.name, (name) => console.log("name:", name));
