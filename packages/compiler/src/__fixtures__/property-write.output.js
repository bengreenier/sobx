import { observable } from "@sobx/runtime";
// MobX-style: state.count = 1 should become state.set("count", 1)
import { ProxyLike } from "@sobx/runtime";
const state = new ProxyLike({
  count: 0
});
state.set("count", 1);
