import { system, world } from "@minecraft/server";

const DIMENSION_ID = "custom:my_dimension";

// 1. Register the custom dimension
system.beforeEvents.startup.subscribe((event) => {
    event.dimensionRegistry.registerCustomDimension(DIMENSION_ID);
});

// 2. Generate the platform with a retry mechanism
world.afterEvents.playerDimensionChange.subscribe((event) => {
    if (event.toDimension.id === DIMENSION_ID) {
        
        let attempts = 0;
        
        // Create an interval that runs every 10 ticks (0.5 seconds)
        const intervalId = system.runInterval(() => {
            attempts++;
            
            try {
                // Try to build the platform
                event.toDimension.runCommand("fill -2 100 -2 2 100 2 stone");
                
                // If the command succeeds (chunk is loaded), stop the loop!
                system.clearRun(intervalId);
                
            } catch (error) {
                // If it fails (chunk not loaded yet), it will catch the error and try again next tick
                
                // Safety net: stop trying after 20 attempts (10 seconds) so it doesn't loop forever
                if (attempts >= 20) {
                    system.clearRun(intervalId);
                    console.warn("Failed to generate platform after 10 seconds.");
                }
            }
        }, 10);
    }
});