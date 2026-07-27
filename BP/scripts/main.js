import { system } from "@minecraft/server";

const TEST_DIM_ID = "pulse:test";

system.beforeEvents.startup.subscribe((event) => {
  event.dimensionRegistry.registerCustomDimension(TEST_DIM_ID);
});
