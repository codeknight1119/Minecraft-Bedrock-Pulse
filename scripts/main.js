import { system, world } from "@minecraft/server";

const DIMENSION_ID = "custom:my_dimension";

// Generation Settings
const GENERATION_RADIUS = 2; // Chunks around the player (2 = 5x5 chunk grid around player)
const TASKS_PER_TICK = 8;     // Column fill commands per tick (lower = smoother, higher = faster)

const generatedChunks = new Set();
const taskQueue = [];

// 1. Register custom dimension on startup
system.beforeEvents.startup.subscribe((event) => {
    event.dimensionRegistry.registerCustomDimension(DIMENSION_ID);
});

// 2. Helper: Queue a chunk if it hasn't been created yet
function queueChunkForGeneration(chunkX, chunkZ) {
    const chunkKey = `${chunkX},${chunkZ}`;

    // Overwrite Prevention: Skip if chunk was already built
    if (generatedChunks.has(chunkKey)) return;
    generatedChunks.add(chunkKey);

    const startX = chunkX * 16;
    const startZ = chunkZ * 16;

    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            const worldX = startX + x;
            const worldZ = startZ + z;

            // Simple height math placeholder
            const height = 65 + Math.floor(Math.sin(worldX * 0.1) * 4 + Math.cos(worldZ * 0.1) * 4);

            taskQueue.push({ x: worldX, z: worldZ, height: height });
        }
    }
}

// 3. Dynamic Player Scanner (Runs every 10 ticks / 0.5s)
system.runInterval(() => {
    const dim = world.getDimension(DIMENSION_ID);
    const players = dim.getPlayers();

    for (const player of players) {
        // Convert player's X and Z coordinates to Chunk coordinates
        const playerChunkX = Math.floor(player.location.x / 16);
        const playerChunkZ = Math.floor(player.location.z / 16);

        // Scan all neighbor chunks within the generation radius
        for (let cx = playerChunkX - GENERATION_RADIUS; cx <= playerChunkX + GENERATION_RADIUS; cx++) {
            for (let cz = playerChunkZ - GENERATION_RADIUS; cz <= playerChunkZ + GENERATION_RADIUS; cz++) {
                queueChunkForGeneration(cx, cz);
            }
        }
    }
}, 10);

// 4. Time-Sliced Task Queue Worker (Runs every tick)
system.runInterval(() => {
    if (taskQueue.length === 0) return;

    const dim = world.getDimension(DIMENSION_ID);

    for (let i = 0; i < TASKS_PER_TICK && taskQueue.length > 0; i++) {
        const task = taskQueue.shift();

        try {
            dim.runCommand(`fill ${task.x} 0 ${task.z} ${task.x} ${task.height - 1} ${task.z} stone`);
            dim.runCommand(`setblock ${task.x} ${task.height} ${task.z} grass_block`);
        } catch (error) {
            // Fails silently if chunk isn't loaded into memory yet
        }
    }
}, 1);