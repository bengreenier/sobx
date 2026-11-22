// The "no-proxies" test project: the whole suite with observables that aren't behind proxies.
import { configure } from "../src/index.js";

configure({ useProxies: "never" });
