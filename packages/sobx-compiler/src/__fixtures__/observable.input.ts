import { observable } from "sobx";
// MobX-style: observable() should become new ProxyLike()
const state = observable({ count: 0 });
