import { observable, reaction } from "@sobx/runtime";
// Reaction as "sync to external system" (e.g. localStorage, log) – MobX docs pattern
import { ProxyLike } from "@sobx/runtime";
const state = new ProxyLike({
  value: ""
});
reaction(() => state.get("value"), value => console.log("synced:", value));
