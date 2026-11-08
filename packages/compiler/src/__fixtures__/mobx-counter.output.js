import { observable, reaction } from "mobx";
// MobX-style counter: observable({ count: 0 }) + reaction + increment (vanilla JS pattern)
import { ProxyLike } from "@sobx/runtime";
const counter = new ProxyLike({
  count: 0
});
(() => {
  const __d = [];
  __d.push(counter.addObserver("count", (_k, _prev, curr) => (n => console.log(n))(curr)));
  (n => console.log(n))((() => counter.get("count"))());
  return () => {
    __d.forEach(x => x.dispose());
  };
})();
counter.set("count", counter.get("count") + 1);
