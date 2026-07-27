import { system } from "@minecraft/server";

const VOID_ARENA_ID = "custom_dim:void_arena";
const SKY_LOUNGE_ID = "custom_dim:sky_lounge";

system.beforeEvents.startup.subscribe((event) => {
  event.dimensionRegistry.registerCustomDimension(VOID_ARENA_ID);
  event.dimensionRegistry.registerCustomDimension(SKY_LOUNGE_ID);
});