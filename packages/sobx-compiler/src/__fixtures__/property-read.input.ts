// MobX-style: state.count should become state.get("count")
const state = observable({ count: 0 });
console.log(state.count);
