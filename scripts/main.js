import { system, world } from "@minecraft/server";
import {Biome} from "./Biome.js"
/*
 * ============================================================================
 * PULSE CUSTOM DIMENSION GENERATOR
 * ============================================================================
 *
 * The custom dimension itself is a void dimension.
 * This script generates terrain around players.
 *
 * Generation pipeline:
 *
 *     DISCOVER
 *        ↓
 *      QUEUED
 *        ↓
 *      LOADING
 *        ↓
 *      WAITING
 *        ↓
 *    GENERATING
 *        ↓
 *    VERIFYING
 *        ↓
 *    GENERATED
 *
 * Failed chunks are returned to the queue and retried.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const DIMENSION_ID = "custom:my_dimension";

/*
 * How far ahead of players to generate.
 *
 * 3 = 7x7 chunks.
 */
const GENERATION_RADIUS = 3;

/*
 * How frequently player positions are scanned.
 *
 * 10 ticks = 0.5 seconds.
 */
const PLAYER_SCAN_INTERVAL = 10;

/*
 * How many terrain rows are generated per tick.
 *
 * A chunk has 16 rows.
 *
 * Smaller values are slower but significantly safer.
 */
const ROWS_PER_TICK = 2;

/*
 * Number of ticks to wait after creating the ticking area before
 * touching blocks.
 */
const CHUNK_LOAD_WAIT_TICKS = 3;

/*
 * Number of ticks to wait before verifying a finished chunk.
 */
const VERIFY_WAIT_TICKS = 2;

/*
 * Number of attempts before we temporarily give up on a chunk.
 *
 * The chunk can still be rediscovered later.
 */
const MAX_GENERATION_ATTEMPTS = 5;

// ============================================================================
// TERRAIN SETTINGS
// ============================================================================

const BASE_HEIGHT = 64;
const MIN_HEIGHT = 56;
const MAX_HEIGHT = 72;

// ============================================================================
// GENERATOR STATE
// ============================================================================

/*
 * Chunk state map.
 *
 * Possible states:
 *
 *   queued
 *   loading
 *   waiting
 *   generating
 *   verifying
 *   generated
 */
const chunkStates = new Map();

/*
 * Chunks waiting to be processed.
 */
const generationQueue = [];

/*
 * The chunk currently being processed.
 *
 * We deliberately generate ONLY ONE chunk at a time.
 */
let activeChunk = null;

/*
 * We reuse a single ticking area.
 */
const TICKING_AREA_NAME = "pulse_generator_area";

let tickingAreaActive = false;

//Biomes
const B_plains = new Biome({
    name: "Plains",

    minTemperature: 0.4,
    maxTemperature: 0.7,

    minHumidity: 0.3,
    maxHumidity: 0.7,

    surfaceBlock: "grass_block",
    subsurfaceBlock: "dirt"
});

// 1. A chilly, high-altitude spruce forest
const B_frozenTaiga = new Biome({
    name: "Frozen Taiga",

    minTemperature: -0.5,
    maxTemperature: 0.1,

    minHumidity: 0.4,
    maxHumidity: 0.8,

    surfaceBlock: "snow_block",
    subsurfaceBlock: "coarse_dirt"
});

// 2. A dark, mystical sculk-infested wasteland
const B_deepDarkBarrens = new Biome({
    name: "Deep Dark Barrens",

    minTemperature: 0.2,
    maxTemperature: 0.5,

    minHumidity: 0.1,
    maxHumidity: 0.4,

    surfaceBlock: "sculk",
    subsurfaceBlock: "deepslate"
});

// 3. A fiery, volcanic badlands concept
const B_obsidianCrag = new Biome({
    name: "Obsidian Crag",

    minTemperature: 0.8,
    maxTemperature: 1.0,

    minHumidity: 0.0,
    maxHumidity: 0.2,

    surfaceBlock: "basalt",
    subsurfaceBlock: "blackstone"
});

// 4. An eerie, nether-like corruption spreading on the surface
const B_crimsonHollow = new Biome({
    name: "Crimson Hollow",

    minTemperature: 0.7,
    maxTemperature: 0.9,

    minHumidity: 0.5,
    maxHumidity: 0.9,

    surfaceBlock: "crimson_nylium",
    subsurfaceBlock: "netherrack"
});

// 5. A lush, subterranean-themed crystal field
const B_amethystGlade = new Biome({
    name: "Amethyst Glade",

    minTemperature: 0.3,
    maxTemperature: 0.6,

    minHumidity: 0.6,
    maxHumidity: 0.9,

    surfaceBlock: "moss_block",
    subsurfaceBlock: "smooth_basalt"
});

const biomes = [B_amethystGlade, B_crimsonHollow, B_deepDarkBarrens, B_frozenTaiga, B_obsidianCrag, B_plains]

// ============================================================================
// CHUNK UTILITIES
// ============================================================================

function chunkKey(chunkX, chunkZ) {
    return `${chunkX},${chunkZ}`;
}

function worldToChunk(value) {
    return Math.floor(value / 16);
}

function chunkToWorld(value) {
    return value * 16;
}

/**
 * Add a chunk to the generation queue.
 */
function queueChunk(chunkX, chunkZ) {

    const key = chunkKey(
        chunkX,
        chunkZ
    );

    /*
     * Don't queue anything that already has a state.
     */
    if (chunkStates.has(key)) {
        return false;
    }

    chunkStates.set(
        key,
        "queued"
    );

    generationQueue.push({
        x: chunkX,
        z: chunkZ,
        key,
        attempts: 0
    });

    return true;
}

// ============================================================================
// TERRAIN
// ============================================================================

/**
 * Deterministic terrain-height function.
 *
 * This is deliberately isolated so we can later replace it with proper
 * terrain noise / biome generation.
 */
const test_seed = Math.floor(Math.random() * 10000)
const terrainGen = new TerrainNoise(test_seed, 0.02);

function getTerrainHeight(x, z) {
    const noise = terrainGen.noise2D(x, z);

    return Math.round(
        BASE_HEIGHT +
        noise * 16
    );
}

// ============================================================================
// TICKING AREA MANAGEMENT
// ============================================================================

function removeTickingArea(dimension) {

    if (!tickingAreaActive) {
        return;
    }

    try {

        dimension.runCommand(
            `tickingarea remove ${TICKING_AREA_NAME}`
        );

    } catch {
        /*
         * It may already have been removed.
         */
    }

    tickingAreaActive = false;
}

function createTickingArea(
    dimension,
    chunkX,
    chunkZ
) {

    /*
     * Always clean up the previous area first.
     */
    removeTickingArea(
        dimension
    );

    const centerX =
        chunkToWorld(chunkX) + 8;

    const centerZ =
        chunkToWorld(chunkZ) + 8;

    try {

        /*
         * Radius 0 = the chunk containing the center.
         */
        dimension.runCommand(
            `tickingarea add circle ${centerX} 64 ${centerZ} 0 ${TICKING_AREA_NAME}`
        );

        tickingAreaActive = true;

        return true;

    } catch (error) {

        console.warn(
            `[Pulse] Failed to create ticking area for ${chunkX},${chunkZ}: ${error}`
        );

        return false;
    }
}

// ============================================================================
// CHUNK GENERATION
// ============================================================================

/**
 * Generate one horizontal row of a chunk.
 *
 * We do NOT generate all 256 columns at once.
 */

const TempMap = new TerrainNoise(Math.floor(Math.random() * 1000))

function generateChunkRow(
    dimension,
    chunk,
    localZ
) {

    let currentBiome = null
    let searchDone = false
    const tempNoiseVal = TempMap.noise2D(chunk.x, chunk.z)
    biomes.forEach(biome => {
        if(biome.minTemperature < tempNoiseVal && tempNoiseVal < biome.maxTemperature ){
            searchDone = Math.random() > 0.5 ? true : false
            currentBiome = biome
            if(searchDone){
                break
            }
        }
    });
    const startX =
        chunkToWorld(chunk.x);

    const startZ =
        chunkToWorld(chunk.z);

    const worldZ =
        startZ + localZ;

    for (
        let localX = 0;
        localX < 16;
        localX++
    ) {

        const worldX =
            startX + localX;

        const height =
            getTerrainHeight(
                worldX,
                worldZ
            );

        /*
         * Stone core.
         */
        if (
            height > BASE_HEIGHT
        ) {

            dimension.runCommand(
                `fill ${worldX} ${BASE_HEIGHT} ${worldZ} ${worldX} ${height - 3} ${worldZ} ${biome.subsurfaceBlock}`
            );
        }
        /*
         * Dirt layer.
         */
        dimension.runCommand(
            `fill ${worldX} ${height - 2} ${worldZ} ${worldX} ${height - 1} ${worldZ} ${biome.surfaceBlock}`
        );

        /*
         * Grass surface.
         */
        dimension.runCommand(
            `setblock ${worldX} ${height} ${worldZ} grass_block`
        );
    }
}

// ============================================================================
// CHUNK VERIFICATION
// ============================================================================

/**
 * Verify that the chunk actually contains terrain.
 *
 * We intentionally check a few points instead of scanning the entire chunk.
 */
function verifyChunk(
    dimension,
    chunk
) {

    const startX =
        chunkToWorld(chunk.x);

    const startZ =
        chunkToWorld(chunk.z);

    const testPoints = [
        [0, 0],
        [8, 0],
        [15, 0],
        [0, 8],
        [8, 8],
        [15, 8],
        [0, 15],
        [8, 15],
        [15, 15]
    ];

    let validPoints = 0;

    for (
        const [localX, localZ]
        of testPoints
    ) {

        const x =
            startX + localX;

        const z =
            startZ + localZ;

        const expectedHeight =
            getTerrainHeight(
                x,
                z
            );

        try {

            const block =
                dimension.getBlock({
                    x,
                    y: expectedHeight,
                    z
                });

            if (
                block &&
                block.typeId ===
                "minecraft:grass_block"
            ) {

                validPoints++;
            }

        } catch {
            /*
             * Chunk isn't available yet.
             */
        }
    }

    /*
     * Require most of the test points to exist.
     */
    return validPoints >= 7;
}

// ============================================================================
// ACTIVE CHUNK PROCESSOR
// ============================================================================

function beginNextChunk(dimension) {

    if (activeChunk !== null) {
        return;
    }

    if (
        generationQueue.length === 0
    ) {
        return;
    }

    /*
     * Take the first chunk in the queue.
     */
    const chunk =
        generationQueue.shift();

    if (!chunk) {
        return;
    }

    /*
     * It may have been generated while waiting.
     */
    if (
        chunkStates.get(
            chunk.key
        ) !== "queued"
    ) {
        return;
    }

    activeChunk = {
        ...chunk,

        attempts:
            chunk.attempts + 1,

        waitTicks: 0,

        verifyTicks: 0,

        nextRow: 0
    };

    chunkStates.set(
        chunk.key,
        "loading"
    );

    /*
     * Start loading the chunk.
     */
    if (
        !createTickingArea(
            dimension,
            chunk.x,
            chunk.z
        )
    ) {

        failActiveChunk(
            dimension,
            "Could not create ticking area"
        );

        return;
    }

    /*
     * Move into the explicit waiting state.
     */
    chunkStates.set(
        chunk.key,
        "waiting"
    );
}

// ============================================================================
// FAILURE / RETRY
// ============================================================================

function failActiveChunk(
    dimension,
    reason
) {

    if (!activeChunk) {
        return;
    }

    const chunk =
        activeChunk;

    console.warn(
        `[Pulse] Chunk ${chunk.key} failed: ${reason}`
    );

    removeTickingArea(
        dimension
    );

    activeChunk = null;

    /*
     * Retry unless we've failed too many times.
     */
    if (
        chunk.attempts <
        MAX_GENERATION_ATTEMPTS
    ) {

        chunkStates.delete(
            chunk.key
        );

        generationQueue.push({
            ...chunk,
            nextRow: 0
        });

        chunkStates.set(
            chunk.key,
            "queued"
        );

        console.warn(
            `[Pulse] Retrying ${chunk.key} (${chunk.attempts}/${MAX_GENERATION_ATTEMPTS})`
        );

    } else {

        /*
         * Don't permanently mark it generated.
         *
         * Delete the state so the normal player scanner can discover it
         * again later.
         */
        chunkStates.delete(
            chunk.key
        );

        console.warn(
            `[Pulse] Giving up on ${chunk.key} for now. It can be retried later.`
        );
    }
}

// ============================================================================
// GENERATION WORKER
// ============================================================================

function processActiveChunk() {

    const dimension =
        world.getDimension(
            DIMENSION_ID
        );

    /*
     * Start a new chunk if necessary.
     */
    if (
        activeChunk === null
    ) {

        beginNextChunk(
            dimension
        );

        return;
    }

    const chunk =
        activeChunk;

    // ------------------------------------------------------------------------
    // WAITING FOR CHUNK
    // ------------------------------------------------------------------------

    if (
        chunkStates.get(
            chunk.key
        ) === "waiting"
    ) {

        chunk.waitTicks++;

        /*
         * Give Minecraft several ticks to actually load the ticking area.
         */
        if (
            chunk.waitTicks >=
            CHUNK_LOAD_WAIT_TICKS
        ) {

            chunkStates.set(
                chunk.key,
                "generating"
            );
/*
            console.warn(
                `[Pulse] Loaded chunk ${chunk.key}, beginning generation`
            );*/
        }
        return;
    }

    // ------------------------------------------------------------------------
    // GENERATING
    // ------------------------------------------------------------------------

    if (
        chunkStates.get(
            chunk.key
        ) === "generating"
    ) {

        try {

            /*
             * Generate only a few rows this tick.
             */
            const endRow =
                Math.min(
                    16,
                    chunk.nextRow +
                    ROWS_PER_TICK
                );

            for (
                let row =
                    chunk.nextRow;

                row < endRow;

                row++
            ) {

                generateChunkRow(
                    dimension,
                    chunk,
                    row
                );
            }

            chunk.nextRow =
                endRow;

            /*
             * All 16 rows are complete.
             */
            if (
                chunk.nextRow >= 16
            ) {

                chunkStates.set(
                    chunk.key,
                    "verifying"
                );

                chunk.verifyTicks = 0;
/*
                console.warn(
                    `[Pulse] Finished block placement for ${chunk.key}`
                );
*/            }

        } catch (error) {

            failActiveChunk(
                dimension,
                `Generation error: ${error}`
            );
        }

        return;
    }

    // ------------------------------------------------------------------------
    // VERIFYING
    // ------------------------------------------------------------------------

    if (
        chunkStates.get(
            chunk.key
        ) === "verifying"
    ) {

        chunk.verifyTicks++;

        /*
         * Give block updates a couple ticks before checking.
         */
        if (
            chunk.verifyTicks <
            VERIFY_WAIT_TICKS
        ) {
            return;
        }

        try {

            const valid =
                verifyChunk(
                    dimension,
                    chunk
                );

            if (valid) {

                chunkStates.set(
                    chunk.key,
                    "generated"
                );
/*
                console.warn(
                    `[Pulse] Chunk ${chunk.key} VERIFIED`
                );
*/
                removeTickingArea(
                    dimension
                );

                activeChunk = null;

            } else {

                failActiveChunk(
                    dimension,
                    "Verification failed"
                );
            }

        } catch (error) {

            failActiveChunk(
                dimension,
                `Verification error: ${error}`
            );
        }
    }
}

// ============================================================================
// PLAYER SCANNING
// ============================================================================

function scanPlayers() {

    const dimension =
        world.getDimension(
            DIMENSION_ID
        );

    const players =
        dimension.getPlayers();

    if (
        players.length === 0
    ) {
        return;
    }

    for (
        const player of players
    ) {

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
// QUEUE PRIORITIZATION
// ============================================================================

function prioritizeQueue() {

    if (
        generationQueue.length < 2
    ) {
        return;
    }

    const dimension =
        world.getDimension(
            DIMENSION_ID
        );

    const players =
        dimension.getPlayers();

    if (
        players.length === 0
    ) {
        return;
    }

    generationQueue.sort(
        (a, b) => {

            let distanceA =
                Infinity;

            let distanceB =
                Infinity;

            for (
                const player
                of players
            ) {

                const playerChunkX =
                    worldToChunk(
                        player.location.x
                    );

                const playerChunkZ =
                    worldToChunk(
                        player.location.z
                    );

                const ax =
                    a.x -
                    playerChunkX;

                const az =
                    a.z -
                    playerChunkZ;

                const bx =
                    b.x -
                    playerChunkX;

                const bz =
                    b.z -
                    playerChunkZ;

                distanceA =
                    Math.min(
                        distanceA,
                        ax * ax +
                        az * az
                    );

                distanceB =
                    Math.min(
                        distanceB,
                        bx * bx +
                        bz * bz
                    );
            }

            return (
                distanceA -
                distanceB
            );
        }
    );
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
            `[Pulse] Registered ${DIMENSION_ID}`
        );
    }
);

// ============================================================================
// START SYSTEMS
// ============================================================================

/*
 * Discover chunks around players.
 */
system.runInterval(
    scanPlayers,
    PLAYER_SCAN_INTERVAL
);

/*
 * Reorder the queue frequently so moving players get priority.
 */
system.runInterval(
    prioritizeQueue,
    10
);

/*
 * The generator state machine runs every tick.
 */
system.runInterval(
    processActiveChunk,
    1
);

// ============================================================================
// PLAYER ENTERS DIMENSION
// ============================================================================

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

        const chunkX =
            worldToChunk(
                player.location.x
            );

        const chunkZ =
            worldToChunk(
                player.location.z
            );

        /*
         * Immediately prioritize the 3x3 area around the player.
         */
        for (
            let x = chunkX - 1;
            x <= chunkX + 1;
            x++
        ) {

            for (
                let z = chunkZ - 1;
                z <= chunkZ + 1;
                z++
            ) {

                queueChunk(
                    x,
                    z
                );
            }
        }

        console.warn(
            `[Pulse] Player entered ${DIMENSION_ID} at chunk ${chunkX},${chunkZ}`
        );
    }
);