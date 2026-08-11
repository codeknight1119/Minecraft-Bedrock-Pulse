import { system, world } from "@minecraft/server";
import { Biome } from "./biome.js";
import { TerrainNoise } from "./TerrainGenerator.js";

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
const GENERATION_RADIUS = 3;
const PLAYER_SCAN_INTERVAL = 10;
const ROWS_PER_TICK = 2;
const CHUNK_LOAD_WAIT_TICKS = 3;
const VERIFY_WAIT_TICKS = 2;
const MAX_GENERATION_ATTEMPTS = 5;

// ============================================================================
// TERRAIN SETTINGS
// ============================================================================

const BASE_HEIGHT = 64;
const MIN_HEIGHT = 56;
const MAX_HEIGHT = 72;

// ============================================================================
// WORLD SEED / NOISE MAPS
// ============================================================================

/*
 * One seed controls the entire world.
 * Every noise map gets a different offset so they are related to the same
 * world seed without producing identical patterns.
 *
 * This is temporary while we experiment. Later this should come from the
 * WorldGenerator configuration.
 */
const WORLD_SEED = Math.floor(Math.random() * 1000000);

const terrainGen = new TerrainNoise(WORLD_SEED, 0.02);

/*
 * Climate changes much more slowly than terrain.
 * A low frequency means large regions of similar climate.
 */
const temperatureMap = new TerrainNoise(WORLD_SEED + 1000, 0.003);
const humidityMap = new TerrainNoise(WORLD_SEED + 2000, 0.004);

/*
 * Used only when several biomes are valid for the same climate.
 * This keeps the choice deterministic while still allowing overlapping
 * temperature/humidity ranges to produce different biomes.
 */
const biomeSelectionMap = new TerrainNoise(WORLD_SEED + 3000, 0.01);

// ============================================================================
// GENERATOR STATE
// ============================================================================

const chunkStates = new Map();
const generationQueue = [];
let activeChunk = null;

const TICKING_AREA_NAME = "pulse_generator_area";
let tickingAreaActive = false;

// ============================================================================
// BIOMES
// ============================================================================

const B_plains = new Biome({
    name: "Plains",
    minTemperature: 0.4,
    maxTemperature: 0.7,
    minHumidity: 0.3,
    maxHumidity: 0.7,
    surfaceBlock: "grass_block",
    subsurfaceBlock: "dirt"
});

const B_frozenTaiga = new Biome({
    name: "Frozen Taiga",
    minTemperature: -0.5,
    maxTemperature: 0.1,
    minHumidity: 0.4,
    maxHumidity: 0.8,
    surfaceBlock: "snow_block",
    subsurfaceBlock: "coarse_dirt"
});

const B_deepDarkBarrens = new Biome({
    name: "Deep Dark Barrens",
    minTemperature: 0.2,
    maxTemperature: 0.5,
    minHumidity: 0.1,
    maxHumidity: 0.4,
    surfaceBlock: "sculk",
    subsurfaceBlock: "deepslate"
});

const B_obsidianCrag = new Biome({
    name: "Obsidian Crag",
    minTemperature: 0.8,
    maxTemperature: 1.0,
    minHumidity: 0.0,
    maxHumidity: 0.2,
    surfaceBlock: "basalt",
    subsurfaceBlock: "blackstone"
});

const B_crimsonHollow = new Biome({
    name: "Crimson Hollow",
    minTemperature: 0.7,
    maxTemperature: 0.9,
    minHumidity: 0.5,
    maxHumidity: 0.9,
    surfaceBlock: "crimson_nylium",
    subsurfaceBlock: "netherrack"
});

const B_amethystGlade = new Biome({
    name: "Amethyst Glade",
    minTemperature: 0.3,
    maxTemperature: 0.6,
    minHumidity: 0.6,
    maxHumidity: 0.9,
    surfaceBlock: "moss_block",
    subsurfaceBlock: "smooth_basalt"
});

const biomes = [
    B_amethystGlade,
    B_crimsonHollow,
    B_deepDarkBarrens,
    B_frozenTaiga,
    B_obsidianCrag,
    B_plains
];

// ============================================================================
// BIOME SELECTION
// ============================================================================

/**
 * Convert the noise output from roughly -1..1 into 0..1.
 */
function normalizeNoise(value) {
    return (value + 1) / 2;
}

/**
 * Get the biome for a world position.
 *
 * Temperature is used first to create the candidate pool. This preserves
 * your overlapping-temperature idea: a temperature can belong to several
 * possible biomes.
 *
 * Humidity then filters that pool. If several biomes still fit, a separate
 * deterministic noise value chooses between them. No Math.random() is used,
 * so the same seed and coordinates always produce the same biome.
 */
function getBiome(x, z) {

    const temperature = normalizeNoise(
        temperatureMap.noise2D(x, z)
    );

    const humidity = normalizeNoise(
        humidityMap.noise2D(x, z)
    );

    /*
     * Step 1: temperature candidates.
     */
    const temperatureCandidates = biomes.filter(
        biome =>
            temperature >= biome.minTemperature &&
            temperature <= biome.maxTemperature
    );

    if (temperatureCandidates.length === 0) {
        return B_plains;
    }

    /*
     * Step 2: humidity candidates among the temperature candidates.
     */
    const climateCandidates = temperatureCandidates.filter(
        biome =>
            humidity >= biome.minHumidity &&
            humidity <= biome.maxHumidity
    );

    if (climateCandidates.length === 0) {
        /*
         * If humidity doesn't match any of the temperature candidates,
         * keep the temperature result rather than producing a hole in the
         * biome map. The selection noise still gives us deterministic variety.
         */
        return chooseBiome(
            temperatureCandidates,
            x,
            z
        );
    }

    return chooseBiome(
        climateCandidates,
        x,
        z
    );
}

/**
 * Deterministically select one biome from a list of valid candidates.
 */
function chooseBiome(candidates, x, z) {

    if (candidates.length === 1) {
        return candidates[0];
    }

    const noise = normalizeNoise(
        biomeSelectionMap.noise2D(x, z)
    );

    const index = Math.min(
        candidates.length - 1,
        Math.floor(noise * candidates.length)
    );

    return candidates[index];
}

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

function queueChunk(chunkX, chunkZ) {

    const key = chunkKey(chunkX, chunkZ);

    if (chunkStates.has(key)) {
        return false;
    }

    chunkStates.set(key, "queued");

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

function getTerrainHeight(x, z) {

    const noise = terrainGen.noise2D(x, z);

    return Math.max(
        MIN_HEIGHT,
        Math.min(
            MAX_HEIGHT,
            Math.round(BASE_HEIGHT + noise * 16)
        )
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
        // It may already have been removed.
    }

    tickingAreaActive = false;
}

function createTickingArea(dimension, chunkX, chunkZ) {

    removeTickingArea(dimension);

    const centerX = chunkToWorld(chunkX) + 8;
    const centerZ = chunkToWorld(chunkZ) + 8;

    try {
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

function generateChunkRow(dimension, chunk, localZ) {

    const startX = chunkToWorld(chunk.x);
    const startZ = chunkToWorld(chunk.z);
    const worldZ = startZ + localZ;

    for (let localX = 0; localX < 16; localX++) {

        const worldX = startX + localX;
        const height = getTerrainHeight(worldX, worldZ);
        const biome = getBiome(worldX, worldZ);

        /*
         * Underground material.
         *
         * For now, we still only fill from BASE_HEIGHT upward. This preserves
         * the reliable generator behavior while the underground system is
         * developed separately.
         */
        if (height > BASE_HEIGHT) {
            dimension.runCommand(
                `fill ${worldX} ${BASE_HEIGHT} ${worldZ} ${worldX} ${height - 3} ${worldZ} ${biome.subsurfaceBlock}`
            );
        }

        /*
         * Two-block surface/subsurface layer.
         */
        dimension.runCommand(
            `fill ${worldX} ${height - 2} ${worldZ} ${worldX} ${height - 1} ${worldZ} ${biome.subsurfaceBlock}`
        );

        /*
         * Biome surface.
         */
        dimension.runCommand(
            `setblock ${worldX} ${height} ${worldZ} ${biome.surfaceBlock}`
        );
    }
}

// ============================================================================
// CHUNK VERIFICATION
// ============================================================================

function verifyChunk(dimension, chunk) {

    const startX = chunkToWorld(chunk.x);
    const startZ = chunkToWorld(chunk.z);

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

    for (const [localX, localZ] of testPoints) {

        const x = startX + localX;
        const z = startZ + localZ;
        const expectedHeight = getTerrainHeight(x, z);
        const expectedBiome = getBiome(x, z);

        try {
            const block = dimension.getBlock({
                x,
                y: expectedHeight,
                z
            });

            if (
                block &&
                block.typeId === `minecraft:${expectedBiome.surfaceBlock}`
            ) {
                validPoints++;
            }

        } catch {
            // Chunk isn't available yet.
        }
    }

    return validPoints >= 7;
}

// ============================================================================
// ACTIVE CHUNK PROCESSOR
// ============================================================================

function beginNextChunk(dimension) {

    if (activeChunk !== null || generationQueue.length === 0) {
        return;
    }

    const chunk = generationQueue.shift();

    if (!chunk) {
        return;
    }

    if (chunkStates.get(chunk.key) !== "queued") {
        return;
    }

    activeChunk = {
        ...chunk,
        attempts: chunk.attempts + 1,
        waitTicks: 0,
        verifyTicks: 0,
        nextRow: 0
    };

    chunkStates.set(chunk.key, "loading");

    if (!createTickingArea(dimension, chunk.x, chunk.z)) {
        failActiveChunk(
            dimension,
            "Could not create ticking area"
        );
        return;
    }

    chunkStates.set(chunk.key, "waiting");
}

// ============================================================================
// FAILURE / RETRY
// ============================================================================

function failActiveChunk(dimension, reason) {

    if (!activeChunk) {
        return;
    }

    const chunk = activeChunk;

    console.warn(
        `[Pulse] Chunk ${chunk.key} failed: ${reason}`
    );

    removeTickingArea(dimension);
    activeChunk = null;

    if (chunk.attempts < MAX_GENERATION_ATTEMPTS) {

        chunkStates.delete(chunk.key);

        generationQueue.push({
            ...chunk,
            nextRow: 0
        });

        chunkStates.set(chunk.key, "queued");

        console.warn(
            `[Pulse] Retrying ${chunk.key} (${chunk.attempts}/${MAX_GENERATION_ATTEMPTS})`
        );

    } else {

        chunkStates.delete(chunk.key);

        console.warn(
            `[Pulse] Giving up on ${chunk.key} for now. It can be retried later.`
        );
    }
}

// ============================================================================
// GENERATION WORKER
// ============================================================================

function processActiveChunk() {

    const dimension = world.getDimension(DIMENSION_ID);

    if (activeChunk === null) {
        beginNextChunk(dimension);
        return;
    }

    const chunk = activeChunk;
    const state = chunkStates.get(chunk.key);

    // ------------------------------------------------------------------------
    // WAITING FOR CHUNK
    // ------------------------------------------------------------------------

    if (state === "waiting") {

        chunk.waitTicks++;

        if (chunk.waitTicks >= CHUNK_LOAD_WAIT_TICKS) {
            chunkStates.set(chunk.key, "generating");
        }

        return;
    }

    // ------------------------------------------------------------------------
    // GENERATING
    // ------------------------------------------------------------------------

    if (state === "generating") {

        try {

            const endRow = Math.min(
                16,
                chunk.nextRow + ROWS_PER_TICK
            );

            for (let row = chunk.nextRow; row < endRow; row++) {
                generateChunkRow(dimension, chunk, row);
            }

            chunk.nextRow = endRow;

            if (chunk.nextRow >= 16) {
                chunkStates.set(chunk.key, "verifying");
                chunk.verifyTicks = 0;
            }

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

    if (state === "verifying") {

        chunk.verifyTicks++;

        if (chunk.verifyTicks < VERIFY_WAIT_TICKS) {
            return;
        }

        try {

            const valid = verifyChunk(dimension, chunk);

            if (valid) {

                chunkStates.set(chunk.key, "generated");
                removeTickingArea(dimension);
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

    const dimension = world.getDimension(DIMENSION_ID);
    const players = dimension.getPlayers();

    if (players.length === 0) {
        return;
    }

    for (const player of players) {

        const playerChunkX = worldToChunk(player.location.x);
        const playerChunkZ = worldToChunk(player.location.z);

        for (
            let chunkX = playerChunkX - GENERATION_RADIUS;
            chunkX <= playerChunkX + GENERATION_RADIUS;
            chunkX++
        ) {

            for (
                let chunkZ = playerChunkZ - GENERATION_RADIUS;
                chunkZ <= playerChunkZ + GENERATION_RADIUS;
                chunkZ++
            ) {
                queueChunk(chunkX, chunkZ);
            }
        }
    }
}

// ============================================================================
// QUEUE PRIORITIZATION
// ============================================================================

function prioritizeQueue() {

    if (generationQueue.length < 2) {
        return;
    }

    const dimension = world.getDimension(DIMENSION_ID);
    const players = dimension.getPlayers();

    if (players.length === 0) {
        return;
    }

    generationQueue.sort((a, b) => {

        let distanceA = Infinity;
        let distanceB = Infinity;

        for (const player of players) {

            const playerChunkX = worldToChunk(player.location.x);
            const playerChunkZ = worldToChunk(player.location.z);

            const ax = a.x - playerChunkX;
            const az = a.z - playerChunkZ;
            const bx = b.x - playerChunkX;
            const bz = b.z - playerChunkZ;

            distanceA = Math.min(
                distanceA,
                ax * ax + az * az
            );

            distanceB = Math.min(
                distanceB,
                bx * bx + bz * bz
            );
        }

        return distanceA - distanceB;
    });
}

// ============================================================================
// DIMENSION REGISTRATION
// ============================================================================

system.beforeEvents.startup.subscribe((event) => {

    event.dimensionRegistry.registerCustomDimension(
        DIMENSION_ID
    );

    console.warn(
        `[Pulse] Registered ${DIMENSION_ID}`
    );
});

// ============================================================================
// START SYSTEMS
// ============================================================================

system.runInterval(
    scanPlayers,
    PLAYER_SCAN_INTERVAL
);

system.runInterval(
    prioritizeQueue,
    10
);

system.runInterval(
    processActiveChunk,
    1
);

// ============================================================================
// PLAYER ENTERS DIMENSION
// ============================================================================

world.afterEvents.playerDimensionChange.subscribe((event) => {

    if (event.toDimension.id !== DIMENSION_ID) {
        return;
    }

    const player = event.player;

    const chunkX = worldToChunk(player.location.x);
    const chunkZ = worldToChunk(player.location.z);

    for (let x = chunkX - 1; x <= chunkX + 1; x++) {
        for (let z = chunkZ - 1; z <= chunkZ + 1; z++) {
            queueChunk(x, z);
        }
    }

    console.warn(
        `[Pulse] Player entered ${DIMENSION_ID} at chunk ${chunkX},${chunkZ}`
    );
});
