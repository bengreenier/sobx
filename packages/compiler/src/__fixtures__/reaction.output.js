import { observable, reaction } from "@sobx/runtime";
// MobX-style: reaction() should become addObserver + initial effect
import { ProxyLike } from "@sobx/runtime";
const state = new ProxyLike({
  x: 0
});
reaction(() => state.get("x"), val => console.log(val));
