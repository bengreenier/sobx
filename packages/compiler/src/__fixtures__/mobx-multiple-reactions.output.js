import { observable, reaction } from "mobx";
// One store, multiple reactions (common MobX pattern)
import { ProxyLike } from "@sobx/runtime";
const store = new ProxyLike({
  count: 0,
  name: ""
});
(() => {
  const __d = [];
  __d.push(store.addObserver("count", (_k, _prev, curr) => (n => console.log("count:", n))(curr)));
  (n => console.log("count:", n))((() => store.get("count"))());
  return () => {
    __d.forEach(x => x.dispose());
  };
})();
(() => {
  const __d = [];
  __d.push(store.addObserver("name", (_k, _prev, curr) => (name => console.log("name:", name))(curr)));
  (name => console.log("name:", name))((() => store.get("name"))());
  return () => {
    __d.forEach(x => x.dispose());
  };
})();
