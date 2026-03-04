import { observable } from "sobx";
// MobX-style: observable() should become new ProxyLike()
import { ProxyLike } from "@sobx/core";
const state = new ProxyLike({
  count: 0
});
