import { system } from "@minecraft/server";

const DIMENSION_ID = "custom:my_dimension";

// Register the dimension during the startup event
system.beforeEvents.startup.subscribe((event) => {
    event.dimensionRegistry.registerCustomDimension(DIMENSION_ID);
});