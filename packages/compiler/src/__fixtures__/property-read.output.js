import { observable } from "mobx";
// MobX-style: state.count should become state.get("count")
import { ProxyLike } from "@sobx/core";
const state = new ProxyLike({
  count: 0
});
console.log(state.get("count"));
