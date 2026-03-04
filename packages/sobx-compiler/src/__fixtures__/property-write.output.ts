import { ProxyLike } from "@sobx/core";
// MobX-style: state.count = 1 should become state.set("count", 1)
const state = new ProxyLike({
  count: 0
});
state.set("count", 1);
