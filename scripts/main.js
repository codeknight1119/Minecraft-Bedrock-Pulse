import { system } from "@minecraft/server";

const DIMENSION_ID = "custom:my_dimension";

// Register the dimension during the startup event
system.beforeEvents.startup.subscribe((event) => {
    event.dimensionRegistry.registerCustomDimension(DIMENSION_ID);
});

world.afterEvents.worldInitialize.subscribe(() => {
    // Get reference to your custom dimension
    const customDim = world.getDimension(DIMENSION_ID);

    // Build a 5x5 stone platform around (0, 100, 0) directly from the server
    customDim.runCommand("fill -2 100 -2 2 100 2 stone");
});