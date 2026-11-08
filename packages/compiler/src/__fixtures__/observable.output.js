import { observable } from "@sobx/runtime";
// MobX-style: observable() should become new ProxyLike()
import { ProxyLike as __sobx_ProxyLike } from "@sobx/runtime";
const state = new __sobx_ProxyLike({
  count: 0
});
