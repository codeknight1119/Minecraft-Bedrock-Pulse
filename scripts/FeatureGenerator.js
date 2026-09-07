import { TerrainNoise } from "./TerrainGenerator.js";

export function hashString(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function normalizeNoise(value) {
    return Math.max(0, Math.min(1, (value + 1) / 2));
}

function cellRandom(seed, cellX, cellZ, salt = 0) {
    const value = Math.sin(
        cellX * 127.1 +
        cellZ * 311.7 +
        seed * 74.7 +
        salt * 19.19
    ) * 43758.5453;

    return value - Math.floor(value);
}

export class FeatureGenerator {
    constructor(worldSeed, structures) {
        this.worldSeed = worldSeed;
        this.structures = structures;
        this.featureNoiseMaps = new Map();

        for (const structure of structures) {
            const featureSeed =
                worldSeed + hashString(structure.name);

            this.featureNoiseMaps.set(
                structure.name,
                new TerrainNoise(
                    featureSeed,
                    structure.frequency ?? 0.05
                )
            );
        }
    }

    getStructure(name) {
        return this.structures.find(
            structure => structure.name === name
        );
    }

    getCellCandidate(structure, cellX, cellZ) {
        const cellSize = Math.max(
            1,
            Math.floor(structure.cellSize ?? 8)
        );

        const seed =
            this.worldSeed + hashString(structure.name);

        const offsetX = Math.floor(
            cellRandom(seed, cellX, cellZ, 1) * cellSize
        );

        const offsetZ = Math.floor(
            cellRandom(seed, cellX, cellZ, 2) * cellSize
        );

        return {
            x: cellX * cellSize + offsetX,
            z: cellZ * cellSize + offsetZ
        };
    }

    shouldGenerate(structure, x, z) {
        const noiseMap =
            this.featureNoiseMaps.get(structure.name);

        if (!noiseMap) {
            return false;
        }

        const noise = normalizeNoise(
            noiseMap.noise2D(x, z)
        );

        return noise >= structure.rarity;
    }

    getChunkCandidates(chunkX, chunkZ, chunkSize = 16) {
        const startX = chunkX * chunkSize;
        const startZ = chunkZ * chunkSize;
        const endX = startX + chunkSize - 1;
        const endZ = startZ + chunkSize - 1;

        const candidates = [];

        for (const structure of this.structures) {
            const cellSize = Math.max(
                1,
                Math.floor(structure.cellSize ?? 8)
            );

            const minCellX = Math.floor(startX / cellSize);
            const maxCellX = Math.floor(endX / cellSize);
            const minCellZ = Math.floor(startZ / cellSize);
            const maxCellZ = Math.floor(endZ / cellSize);

            for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
                    const candidate =
                        this.getCellCandidate(
                            structure,
                            cellX,
                            cellZ
                        );

                    if (
                        candidate.x < startX ||
                        candidate.x > endX ||
                        candidate.z < startZ ||
                        candidate.z > endZ
                    ) {
                        continue;
                    }

                    if (
                        !this.shouldGenerate(
                            structure,
                            candidate.x,
                            candidate.z
                        )
                    ) {
                        continue;
                    }

                    candidates.push({
                        structure,
                        x: candidate.x,
                        z: candidate.z
                    });
                }
            }
        }

        return candidates;
    }
}
