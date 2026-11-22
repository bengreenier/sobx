import { observable } from "mobx";
// MobX-style: state.count = 1 should become state.set("count", 1)
const state = observable({ count: 0 });
state.count = 1;
