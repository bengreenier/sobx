import { observable, reaction } from "@sobx/runtime";
// Multiple features in one file: observable, reads, writes, reaction
import { ProxyLike } from "@sobx/runtime";
const store = new ProxyLike({
  count: 0,
  name: ""
});
function increment() {
  store.set("count", store.get("count") + 1);
}
reaction(() => store.get("name"), name => console.log("name:", name));
