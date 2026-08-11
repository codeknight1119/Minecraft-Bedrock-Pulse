export class Biome {
    constructor({
        name,
        minTemperature,
        maxTemperature,
        minHumidity,
        maxHumidity,
        surfaceBlock,
        subsurfaceBlock
    }) {
        this.name = name;

        this.minTemperature = minTemperature;
        this.maxTemperature = maxTemperature;

        this.minHumidity = minHumidity;
        this.maxHumidity = maxHumidity;

        this.surfaceBlock = surfaceBlock;
        this.subsurfaceBlock = subsurfaceBlock;
    }

    matches(temperature, humidity) {
        return (
            temperature >= this.minTemperature &&
            temperature <= this.maxTemperature &&
            humidity >= this.minHumidity &&
            humidity <= this.maxHumidity
        );
    }
}
