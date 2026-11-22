import { observable, reaction } from "@sobx/runtime";
// MobX-style counter: observable({ count: 0 }) + reaction + increment (vanilla JS pattern)
import { ProxyLike } from "@sobx/runtime";
const counter = new ProxyLike({
  count: 0
});
reaction(() => counter.get("count"), n => console.log(n));
counter.set("count", counter.get("count") + 1);
