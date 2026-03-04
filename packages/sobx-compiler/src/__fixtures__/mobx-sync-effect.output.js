import { observable, reaction } from "sobx";
// Reaction as "sync to external system" (e.g. localStorage, log) – MobX docs pattern
import { ProxyLike } from "@sobx/core";
const state = new ProxyLike({
  value: ""
});
(() => {
  const __d = [];
  __d.push(state.addObserver("value", (_k, _prev, curr) => (value => console.log("synced:", value))(curr)));
  (value => console.log("synced:", value))((() => state.get("value"))());
  return () => {
    __d.forEach(x => x.dispose());
  };
})();
