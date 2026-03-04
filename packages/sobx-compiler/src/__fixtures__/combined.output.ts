import { ProxyLike } from "@sobx/core";
// Multiple features in one file: observable, reads, writes, reaction
const store = new ProxyLike({
  count: 0,
  name: ""
});
function increment() {
  store.set("count", store.get("count") + 1);
}
(() => {
  const __d = [];
  __d.push(store.addObserver("name", (_k, _prev, curr) => (name => console.log("name:", name))(curr)));
  (name => console.log("name:", name))((() => store.get("name"))());
  return () => {
    __d.forEach(x => x.dispose());
  };
})();
