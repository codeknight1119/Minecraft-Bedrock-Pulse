import { system, world } from "@minecraft/server";

const DIMENSION_ID = "custom:my_dimension";

// Tracking generated chunks ("chunkX,chunkZ") so we never overwrite land
const generatedChunks = new Set();

// Task queue for time-slicing work across server ticks
const taskQueue = [];

// How many block column tasks to process PER TICK (adjust to balance speed vs lag)
const TASKS_PER_TICK = 8; 

// 1. Register custom dimension on startup
system.beforeEvents.startup.subscribe((event) => {
    event.dimensionRegistry.registerCustomDimension(DIMENSION_ID);
});

// 2. The Time-Sliced Queue Worker (Runs every tick)
system.runInterval(() => {
    if (taskQueue.length === 0) return;

    const dim = world.getDimension(DIMENSION_ID);

    // Process a small batch of tasks this tick to prevent lagging the server
    for (let i = 0; i < TASKS_PER_TICK && taskQueue.length > 0; i++) {
        const task = taskQueue.shift(); // Remove the next task from the front

        try {
            // Fill stone underneath the surface
            dim.runCommand(`fill ${task.x} 0 ${task.z} ${task.x} ${task.height - 1} ${task.z} stone`);
            // Fill surface grass block
            dim.runCommand(`setblock ${task.x} ${task.height} ${task.z} grass_block`);
        } catch (error) {
            // If command fails (chunk unloaded), skip gracefully
        }
    }
}, 1);

// 3. Helper: Converts chunk coordinates to individual column tasks
function queueChunkForGeneration(chunkX, chunkZ) {
    const chunkKey = `${chunkX},${chunkZ}`;

    // Overwrite check: If already generated, abort immediately
    if (generatedChunks.has(chunkKey)) return;
    generatedChunks.add(chunkKey);

    const startX = chunkX * 16;
    const startZ = chunkZ * 16;

    // Break 16x16 chunk into 256 column tasks
    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            const worldX = startX + x;
            const worldZ = startZ + z;

            // Simple wave function math placeholder until we add real Perlin noise
            const height = 65 + Math.floor(Math.sin(worldX * 0.1) * 4 + Math.cos(worldZ * 0.1) * 4);

            taskQueue.push({ x: worldX, z: worldZ, height: height });
        }
    }
}

// 4. Trigger chunk generation when player enters the dimension
world.afterEvents.playerDimensionChange.subscribe((event) => {
    if (event.toDimension.id === DIMENSION_ID) {
        // Queue spawn chunks (Chunk 0,0 and surrounding chunks)
        for (let cx = -1; cx <= 1; cx++) {
            for (let cz = -1; cz <= 1; cz++) {
                queueChunkForGeneration(cx, cz);
            }
        }
    }
});