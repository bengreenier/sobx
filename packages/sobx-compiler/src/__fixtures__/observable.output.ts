import { ProxyLike } from "@sobx/core";
// MobX-style: observable() should become new ProxyLike()
const state = new ProxyLike({
  count: 0
});