import { observable, reaction } from "mobx";
// Reaction as "sync to external system" (e.g. localStorage, log) – MobX docs pattern
const state = observable({ value: "" });
reaction(() => state.value, (value) => console.log("synced:", value));
