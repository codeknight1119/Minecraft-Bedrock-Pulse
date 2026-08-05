import { system, world } from "@minecraft/server";

const DIMENSION_ID = "custom:my_dimension";

// 1. Register the custom dimension
system.beforeEvents.startup.subscribe((event) => {
    event.dimensionRegistry.registerCustomDimension(DIMENSION_ID);
});

// 2. Generate the platform when a player enters the dimension
world.afterEvents.playerDimensionChange.subscribe((event) => {
    if (event.toDimension.id === DIMENSION_ID) {
        // Wait 10 ticks (half a second) to ensure the chunk has fully loaded
        system.runTimeout(() => {
            try {
                event.toDimension.runCommand("fill -2 100 -2 2 100 2 stone");
            } catch (error) {
                console.warn("Failed to generate platform: " + error);
            }
        }, 10);
    }
});