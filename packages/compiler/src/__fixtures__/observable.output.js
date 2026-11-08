import { observable } from "mobx";
// MobX-style: observable() should become new ProxyLike()
import { ProxyLike } from "@sobx/runtime";
const state = new ProxyLike({
  count: 0
});
