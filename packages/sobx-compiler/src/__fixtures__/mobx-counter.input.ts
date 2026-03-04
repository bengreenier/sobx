import { observable, reaction } from "sobx";
// MobX-style counter: observable({ count: 0 }) + reaction + increment (vanilla JS pattern)
const counter = observable({ count: 0 });
reaction(() => counter.count, (n) => console.log(n));
counter.count = counter.count + 1;
