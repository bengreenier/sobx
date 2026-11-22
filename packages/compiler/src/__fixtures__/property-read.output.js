import { observable } from "@sobx/runtime";
// MobX-style: state.count should become state.get("count")
import { ProxyLike } from "@sobx/runtime";
const state = new ProxyLike({
  count: 0
});
console.log(state.get("count"));
