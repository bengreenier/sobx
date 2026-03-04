import { ProxyLike } from "@sobx/core";
// Reaction as "sync to external system" (e.g. localStorage, log) – MobX docs pattern
const state = new ProxyLike({
  value: ""
});
(() => {
  const __d = [];
  __d.push(state.addObserver("value", (_k, _prev, curr) => (value => console.log("synced:", value))(curr)));
  (value => console.log("synced:", value))((() => state.value)());
  return () => {
    __d.forEach(x => x.dispose());
  };
})();
