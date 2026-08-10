import { system, world } from "@minecraft/server";

/*
 * Pulse Custom Dimension Generator
 *
 * The custom dimension is registered as a void dimension.
 * This script procedurally builds terrain around players.
 *
 * Architecture:
 *   player tracking
 *        ↓
 *   chunk queue
 *        ↓
 *   nearest chunks first
 *        ↓
 *   one chunk generated at a time
 *        ↓
 *   chunk marked complete
 *
 * This is intentionally written so the terrain-generation function can
 * eventually be replaced with a proper noise/biome system.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const DIMENSION_ID = "custom:my_dimension";

// How many chunks away from each player should be generated.
//
// 3 = 7x7 chunks around the player.
const GENERATION_RADIUS = 3;

// How often we check player positions.
// 10 ticks = 0.5 seconds.
const PLAYER_SCAN_INTERVAL = 10;

// Maximum number of chunks generated during one worker run.
//
// Keep this low while testing. Terrain generation can be expensive.
const CHUNKS_PER_TICK = 1;

// Terrain settings.
const BASE_HEIGHT = 64;
const MIN_HEIGHT = 56;
const MAX_HEIGHT = 72;

// Temporary ticking area used while generating a chunk.
//
// We intentionally reuse ONE ticking area rather than creating one for
// every chunk.
const TICKING_AREA_NAME = "pulse_generation";

// ============================================================================
// STATE
// ============================================================================

/*
 * Chunk states:
 *
 *   queued
 *   generating
 *   generated
 *
 * A Map is used instead of a Set because "queued" and "generated" are
 * different states.
 */
const chunkStates = new Map();

/*
 * Generation queue.
 *
 * Entries look like:
 *
 * {
 *     x: chunkX,
 *     z: chunkZ,
 *     key: "x,z"
 * }
 */
const generationQueue = [];

// Whether our temporary ticking area currently exists.
let tickingAreaActive = false;

// ============================================================================
// CHUNK UTILITIES
// ============================================================================

/**
 * Creates a unique key for a chunk.
 */
function getChunkKey(chunkX, chunkZ) {
    return `${chunkX},${chunkZ}`;
}

/**
 * Converts a world coordinate into a chunk coordinate.
 *
 * Math.floor is important here because it correctly handles negative
 * coordinates.
 *
 * Example:
 *
 *   x = 0    → chunk 0
 *   x = 15   → chunk 0
 *   x = 16   → chunk 1
 *   x = -1   → chunk -1
 */
function worldToChunk(value) {
    return Math.floor(value / 16);
}

/**
 * Gets the world coordinate of the beginning of a chunk.
 */
function chunkToWorld(chunkCoordinate) {
    return chunkCoordinate * 16;
}

/**
 * Queue a chunk for generation.
 *
 * Returns true if the chunk was newly queued.
 */
function queueChunk(chunkX, chunkZ) {
    const key = getChunkKey(chunkX, chunkZ);

    // Already queued, generating, or generated.
    if (chunkStates.has(key)) {
        return false;
    }

    chunkStates.set(key, "queued");

    generationQueue.push({
        x: chunkX,
        z: chunkZ,
        key,
    });

    return true;
}

// ============================================================================
// TERRAIN GENERATION
// ============================================================================

/**
 * Returns the terrain height at a world coordinate.
 *
 * THIS IS THE PART WE CAN EVENTUALLY REPLACE WITH REAL TERRAIN GENERATION.
 *
 * Right now it uses several sine/cosine waves to make a simple rolling
 * landscape.
 *
 * The important thing is that the function is deterministic:
 *
 *   getTerrainHeight(100, 200)
 *
 * will always return the same value.
 */
function getTerrainHeight(x, z) {
    const largeScale =
        Math.sin(x * 0.045) * 5;

    const mediumScale =
        Math.cos(z * 0.065) * 4;

    const smallScale =
        Math.sin((x + z) * 0.11) * 2;

    const height =
        Math.round(
            BASE_HEIGHT +
            largeScale +
            mediumScale +
            smallScale
        );

    return Math.max(
        MIN_HEIGHT,
        Math.min(MAX_HEIGHT, height)
    );
}

/**
 * Generate a single chunk.
 *
 * This generates all 256 columns belonging to the chunk.
 *
 * Unlike the old implementation, the queue contains ONE task per chunk
 * instead of 256 tasks per chunk.
 */
function generateChunk(dimension, chunkX, chunkZ) {
    const startX = chunkToWorld(chunkX);
    const startZ = chunkToWorld(chunkZ);

    for (let localX = 0; localX < 16; localX++) {
        for (let localZ = 0; localZ < 16; localZ++) {

            const worldX = startX + localX;
            const worldZ = startZ + localZ;

            const height = getTerrainHeight(
                worldX,
                worldZ
            );

            generateColumn(
                dimension,
                worldX,
                worldZ,
                height
            );
        }
    }
}

/**
 * Generate one terrain column.
 *
 * Current terrain:
 *
 *   stone
 *   stone
 *   stone
 *   dirt
 *   dirt
 *   grass
 */
function generateColumn(
    dimension,
    x,
    z,
    height
) {
    // Make the underground.
    if (height > BASE_HEIGHT) {
        dimension.runCommand(
            `fill ${x} ${BASE_HEIGHT} ${z} ${x} ${height - 2} ${z} stone`
        );
    }

    // Dirt layer.
    if (height >= BASE_HEIGHT + 2) {
        dimension.runCommand(
            `fill ${x} ${height - 2} ${z} ${x} ${height - 1} ${z} dirt`
        );
    }

    // Grass surface.
    dimension.runCommand(
        `setblock ${x} ${height} ${z} grass_block`
    );
}

// ============================================================================
// TICKING AREA
// ============================================================================

/**
 * Create the temporary ticking area for a chunk.
 *
 * We reuse the same name every time.
 */
function startChunkLoading(
    dimension,
    chunkX,
    chunkZ
) {
    const centerX =
        chunkToWorld(chunkX) + 8;

    const centerZ =
        chunkToWorld(chunkZ) + 8;

    /*
     * Remove an old generation area first.
     *
     * This prevents stale areas from surviving if generation failed.
     */
    if (tickingAreaActive) {
        stopChunkLoading(dimension);
    }

    try {
        dimension.runCommand(
            `tickingarea add circle ${centerX} 64 ${centerZ} 0 ${TICKING_AREA_NAME}`
        );

        tickingAreaActive = true;

        return true;
    } catch (error) {
        console.warn(
            `[Pulse] Could not create generation ticking area: ${error}`
        );

        return false;
    }
}

/**
 * Remove the temporary ticking area.
 */
function stopChunkLoading(dimension) {
    if (!tickingAreaActive) {
        return;
    }

    try {
        dimension.runCommand(
            `tickingarea remove ${TICKING_AREA_NAME}`
        );
    } catch {
        // It may already have disappeared.
    }

    tickingAreaActive = false;
}

// ============================================================================
// QUEUE PRIORITIZATION
// ============================================================================

/**
 * Calculate the squared distance between two chunks.
 *
 * We use squared distance because we don't need an actual square root.
 */
function chunkDistanceSquared(
    chunkX,
    chunkZ,
    playerChunkX,
    playerChunkZ
) {
    const dx =
        chunkX - playerChunkX;

    const dz =
        chunkZ - playerChunkZ;

    return (
        dx * dx +
        dz * dz
    );
}

/**
 * Sort the queue so chunks closest to players are generated first.
 */
function prioritizeQueue(dimension) {
    const players =
        dimension.getPlayers();

    if (
        players.length === 0 ||
        generationQueue.length < 2
    ) {
        return;
    }

    generationQueue.sort((a, b) => {

        let distanceA = Infinity;
        let distanceB = Infinity;

        for (const player of players) {

            const playerChunkX =
                worldToChunk(
                    player.location.x
                );

            const playerChunkZ =
                worldToChunk(
                    player.location.z
                );

            distanceA = Math.min(
                distanceA,
                chunkDistanceSquared(
                    a.x,
                    a.z,
                    playerChunkX,
                    playerChunkZ
                )
            );

            distanceB = Math.min(
                distanceB,
                chunkDistanceSquared(
                    b.x,
                    b.z,
                    playerChunkX,
                    playerChunkZ
                )
            );
        }

        return distanceA - distanceB;
    });
}

// ============================================================================
// GENERATION WORKER
// ============================================================================

/**
 * Process the generation queue.
 */
function processGenerationQueue() {

    if (generationQueue.length === 0) {
        return;
    }

    const dimension =
        world.getDimension(
            DIMENSION_ID
        );

    // Always prioritize chunks near players.
    prioritizeQueue(dimension);

    for (
        let i = 0;
        i < CHUNKS_PER_TICK &&
        generationQueue.length > 0;
        i++
    ) {

        const chunk =
            generationQueue.shift();

        if (!chunk) {
            return;
        }

        const state =
            chunkStates.get(
                chunk.key
            );

        // Something else already handled this chunk.
        if (state !== "queued") {
            continue;
        }

        chunkStates.set(
            chunk.key,
            "generating"
        );

        let success = false;

        try {

            /*
             * Load the chunk before modifying it.
             */
            if (
                !startChunkLoading(
                    dimension,
                    chunk.x,
                    chunk.z
                )
            ) {
                throw new Error(
                    "Could not create ticking area"
                );
            }

            /*
             * Generate the actual terrain.
             */
            generateChunk(
                dimension,
                chunk.x,
                chunk.z
            );

            success = true;

            chunkStates.set(
                chunk.key,
                "generated"
            );

            console.warn(
                `[Pulse] Generated chunk ${chunk.key}`
            );

        } catch (error) {

            /*
             * IMPORTANT:
             *
             * The old generator marked a chunk as generated BEFORE actually
             * generating it.
             *
             * If anything failed, that chunk could therefore remain
             * permanently broken.
             *
             * Here we remove its state so it can be retried.
             */
            chunkStates.delete(
                chunk.key
            );

            /*
             * Put it back at the END of the queue.
             */
            generationQueue.push(
                chunk
            );

            console.warn(
                `[Pulse] Failed to generate chunk ${chunk.key}: ${error}`
            );

        } finally {

            stopChunkLoading(
                dimension
            );
        }
    }
}

// ============================================================================
// PLAYER TRACKING
// ============================================================================

/**
 * Find all chunks that should exist around every player.
 */
function scanPlayers() {

    const dimension =
        world.getDimension(
            DIMENSION_ID
        );

    const players =
        dimension.getPlayers();

    if (players.length === 0) {
        return;
    }

    for (const player of players) {

        const playerChunkX =
            worldToChunk(
                player.location.x
            );

        const playerChunkZ =
            worldToChunk(
                player.location.z
            );

        for (
            let chunkX =
                playerChunkX -
                GENERATION_RADIUS;

            chunkX <=
            playerChunkX +
            GENERATION_RADIUS;

            chunkX++
        ) {

            for (
                let chunkZ =
                    playerChunkZ -
                    GENERATION_RADIUS;

                chunkZ <=
                    playerChunkZ +
                    GENERATION_RADIUS;

                chunkZ++
            ) {

                queueChunk(
                    chunkX,
                    chunkZ
                );
            }
        }
    }
}

// ============================================================================
// DIMENSION REGISTRATION
// ============================================================================

system.beforeEvents.startup.subscribe(
    (event) => {

        event.dimensionRegistry
            .registerCustomDimension(
                DIMENSION_ID
            );

        console.warn(
            `[Pulse] Registered dimension ${DIMENSION_ID}`
        );
    }
);

// ============================================================================
// START GENERATION SYSTEM
// ============================================================================

/*
 * Check for players every 0.5 seconds.
 */
system.runInterval(
    scanPlayers,
    PLAYER_SCAN_INTERVAL
);

/*
 * Process the generation queue every tick.
 */
system.runInterval(
    processGenerationQueue,
    1
);

// ============================================================================
// DIMENSION ENTRY
// ============================================================================

/*
 * When a player enters Pulse, immediately queue a 3x3 area around them.
 *
 * The normal player scanner will then expand that area to the configured
 * generation radius.
 */
world.afterEvents.playerDimensionChange.subscribe(
    (event) => {

        if (
            event.toDimension.id !==
            DIMENSION_ID
        ) {
            return;
        }

        const player =
            event.player;

        const playerChunkX =
            worldToChunk(
                player.location.x
            );

        const playerChunkZ =
            worldToChunk(
                player.location.z
            );

        for (
            let chunkX =
                playerChunkX - 1;

            chunkX <=
                playerChunkX + 1;

            chunkX++
        ) {

            for (
                let chunkZ =
                    playerChunkZ - 1;

                chunkZ <=
                    playerChunkZ + 1;

                chunkZ++
            ) {

                queueChunk(
                    chunkX,
                    chunkZ
                );
            }
        }

        console.warn(
            `[Pulse] Player entered dimension. Starting local generation around ${playerChunkX},${playerChunkZ}`
        );
    }
);