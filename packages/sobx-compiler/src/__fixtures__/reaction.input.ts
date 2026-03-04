import { observable, reaction } from "sobx";
// MobX-style: reaction() should become addObserver + initial effect
const state = observable({ x: 0 });
reaction(() => state.x, (val) => console.log(val));
