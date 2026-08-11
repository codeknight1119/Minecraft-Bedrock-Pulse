export class TerrainNoise {

    constructor(
        seed,
        frequency = 1,
        amplitude = 1
    ) {
        this.seed = seed;
        this.frequency = frequency;
        this.amplitude = amplitude;
    }

    random2D(x, z) {

        const value =
            Math.sin(
                x * 127.1 +
                z * 311.7 +
                this.seed * 74.7
            ) * 43758.5453;

        return (
            value -
            Math.floor(value)
        );
    }

    gradient(x, z) {

        const angle =
            this.random2D(x, z) *
            Math.PI * 2;

        return {
            x: Math.cos(angle),
            z: Math.sin(angle)
        };
    }

    dotGridGradient(
        gridX,
        gridZ,
        x,
        z
    ) {

        const gradient =
            this.gradient(
                gridX,
                gridZ
            );

        const distanceX =
            x - gridX;

        const distanceZ =
            z - gridZ;

        return (
            gradient.x * distanceX +
            gradient.z * distanceZ
        );
    }

    fade(t) {

        return (
            t * t * t *
            (t * (t * 6 - 15) + 10)
        );
    }

    lerp(a, b, t) {

        return (
            a +
            t * (b - a)
        );
    }

    noise2D(x, z) {

        // Apply frequency.
        x *= this.frequency;
        z *= this.frequency;

        // Find the grid square.
        const x0 =
            Math.floor(x);

        const z0 =
            Math.floor(z);

        const x1 =
            x0 + 1;

        const z1 =
            z0 + 1;

        // Position inside the square.
        const localX =
            x - x0;

        const localZ =
            z - z0;

        // Dot products at the four corners.
        const topLeft =
            this.dotGridGradient(
                x0,
                z0,
                x,
                z
            );

        const topRight =
            this.dotGridGradient(
                x1,
                z0,
                x,
                z
            );

        const bottomLeft =
            this.dotGridGradient(
                x0,
                z1,
                x,
                z
            );

        const bottomRight =
            this.dotGridGradient(
                x1,
                z1,
                x,
                z
            );

        // Smooth interpolation amounts.
        const u =
            this.fade(localX);

        const v =
            this.fade(localZ);

        // Interpolate horizontally.
        const top =
            this.lerp(
                topLeft,
                topRight,
                u
            );

        const bottom =
            this.lerp(
                bottomLeft,
                bottomRight,
                u
            );

        // Interpolate vertically.
        const result =
            this.lerp(
                top,
                bottom,
                v
            );

        return result *
            this.amplitude;
    }
}