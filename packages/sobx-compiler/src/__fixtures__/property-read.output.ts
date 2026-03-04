import { ProxyLike } from "@sobx/core";
// MobX-style: state.count should become state.get("count")
const state = new ProxyLike({
  count: 0
});
console.log(state.get("count"));
