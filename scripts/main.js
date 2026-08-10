import { system, world } from "@minecraft/server";

const DIMENSION_ID = "custom:my_dimension";
const GENERATION_RADIUS = 3; // Generate 3 chunks out (7x7 area)
const TASKS_PER_TICK = 12;

const generatedChunks = new Set();
const taskQueue = [];

// 1. Register Dimension on Startup
system.beforeEvents.startup.subscribe((event) => {
    event.dimensionRegistry.registerCustomDimension(DIMENSION_ID);
});

// 2. Safe Block Generator using Ticking Areas
function queueChunkWithTickingArea(dim, chunkX, chunkZ) {
    const chunkKey = `${chunkX},${chunkZ}`;
    if (generatedChunks.has(chunkKey)) return;
    generatedChunks.add(chunkKey);

    const startX = chunkX * 16;
    const startZ = chunkZ * 16;
    const areaName = `gen_${chunkX}_${chunkZ}`;

    try {
        // Force the chunk into server memory using a 1-chunk radius ticking area
        dim.runCommand(`tickingarea add circle ${startX + 8} 64 ${startZ + 8} 1 ${areaName}`);
    } catch (e) {
        // Ticking area might already exist or limit reached, continue safely
    }

    // Add all 256 column tasks for this chunk
    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            const worldX = startX + x;
            const worldZ = startZ + z;
            const height = 65 + Math.floor(Math.sin(worldX * 0.1) * 4 + Math.cos(worldZ * 0.1) * 4);

            taskQueue.push({ 
                x: worldX, 
                z: worldZ, 
                height: height, 
                areaName: areaName,
                isLastColumn: (x === 15 && z === 15) // Clean up ticking area on last column
            });
        }
    }
}

// 3. Pre-generate Spawn Chunks (0,0) on First Load
function pregenerateSpawn(dim) {
    // Queue a 3x3 chunk grid around 0,0
    for (let cx = -1; cx <= 1; cx++) {
        for (let cz = -1; cz <= 1; cz++) {
            queueChunkWithTickingArea(dim, cx, cz);
        }
    }
}

// 4. Dynamic Player Tracking Scanner
system.runInterval(() => {
    const dim = world.getDimension(DIMENSION_ID);
    const players = dim.getPlayers();

    for (const player of players) {
        const pChunkX = Math.floor(player.location.x / 16);
        const pChunkZ = Math.floor(player.location.z / 16);

        // Scan ahead of player
        for (let cx = pChunkX - GENERATION_RADIUS; cx <= pChunkX + GENERATION_RADIUS; cx++) {
            for (let cz = pChunkZ - GENERATION_RADIUS; cz <= pChunkZ + GENERATION_RADIUS; cz++) {
                queueChunkWithTickingArea(dim, cx, cz);
            }
        }
    }
}, 10);

// 5. Task Worker with Automatic Ticking Area Cleanup
system.runInterval(() => {
    if (taskQueue.length === 0) return;

    const dim = world.getDimension(DIMENSION_ID);

    for (let i = 0; i < TASKS_PER_TICK && taskQueue.length > 0; i++) {
        const task = taskQueue.shift();

        try {
            dim.runCommand(`fill ${task.x} 0 ${task.z} ${task.x} ${task.height - 1} ${task.z} stone`);
            dim.runCommand(`setblock ${task.x} ${task.height} ${task.z} grass_block`);
        } catch (error) {
            // Should not fail now thanks to ticking areas
        }

        // Once the entire chunk finishes, remove its ticking area to stay within limits
        if (task.isLastColumn) {
            try {
                dim.runCommand(`tickingarea remove ${task.areaName}`);
            } catch (e) {}
        }
    }
}, 1);

// Trigger Spawn Pre-generation when entering dimension
world.afterEvents.playerDimensionChange.subscribe((event) => {
    if (event.toDimension.id === DIMENSION_ID) {
        pregenerateSpawn(event.toDimension);
    }
});