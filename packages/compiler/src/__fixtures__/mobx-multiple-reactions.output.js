import { observable, reaction } from "@sobx/runtime";
// One store, multiple reactions (common MobX pattern)
import { ProxyLike } from "@sobx/runtime";
const store = new ProxyLike({
  count: 0,
  name: ""
});
reaction(() => store.get("count"), n => console.log("count:", n));
reaction(() => store.get("name"), name => console.log("name:", name));
