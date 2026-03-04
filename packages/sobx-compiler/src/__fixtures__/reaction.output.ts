import { ProxyLike } from "@sobx/core";
// MobX-style: reaction() should become addObserver + initial effect
const state = new ProxyLike({
  x: 0
});
(() => {
  const __d = [];
  __d.push(state.addObserver("x", (_k, _prev, curr) => (val => console.log(val))(curr)));
  (val => console.log(val))((() => state.x)());
  return () => {
    __d.forEach(x => x.dispose());
  };
})();
