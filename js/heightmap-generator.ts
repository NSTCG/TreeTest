/**
 * Heightmap generation utilities.
 *
 * File format:
 *   .heightmap.bin  — flat Float32Array, row-major (row 0 = world min-Z)
 *   .heightmap.json — metadata sidecar:
 *       { version, resolution, worldSize, originX, originZ, minHeight, maxHeight }
 */

/* ── Noise (same algorithm as planet.ts) ── */

const NOISE_CELL_PERIOD = 16384;

function fract(x: number) { return x - Math.floor(x); }
function wrapNoiseCell(x: number) {
    return ((x % NOISE_CELL_PERIOD) + NOISE_CELL_PERIOD) % NOISE_CELL_PERIOD;
}

function hash(x: number, y: number) {
    const wrappedX = wrapNoiseCell(x);
    const wrappedY = wrapNoiseCell(y);
    const a = 50.0 * fract(wrappedX * 0.3183099 + 0.71);
    const b = 50.0 * fract(wrappedY * 0.3183099 + 0.113);
    return -1.0 + 2.0 * fract(a * b * (a + b));
}

function valueNoise(x: number, y: number) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = fract(x);
    const fy = fract(y);
    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uy = fy * fy * (3.0 - 2.0 * fy);

    const v00 = hash(ix, iy);
    const v10 = hash(ix + 1, iy);
    const v01 = hash(ix, iy + 1);
    const v11 = hash(ix + 1, iy + 1);

    return v00 + ux * (v10 - v00) + uy * (v01 - v00) + ux * uy * (v00 - v10 - v01 + v11);
}

/* ── Public helpers ── */

export interface HeightmapMeta {
    version: number;
    resolution: number;
    worldSize: number;
    originX: number;
    originZ: number;
    minHeight: number;
    maxHeight: number;
}

export interface HeightmapResult {
    bin: Float32Array;
    meta: HeightmapMeta;
}

/**
 * Generate a heightmap filled with the same fBm noise used by Planet.
 *
 * @param worldSize  Side length in world units (e.g. 2000 for 2 km).
 * @param resolution Number of samples per axis (e.g. 1024).
 * @param amplitude  Base amplitude of the noise (same as Planet.amplitude).
 * @param originX    World-space center X of the heightmap region.
 * @param originZ    World-space center Z of the heightmap region.
 * @param octaves    Number of fBm octaves (default 4, matching Planet).
 * @param frequency  Base frequency multiplier (default 0.02, matching Planet).
 */
export function generateHeightmapBinary(
    worldSize: number,
    resolution: number,
    amplitude: number,
    originX = 0,
    originZ = 0,
    octaves = 4,
    frequency = 0.02,
): HeightmapResult {
    const bin = new Float32Array(resolution * resolution);
    let minH = Infinity;
    let maxH = -Infinity;

    let idx = 0;
    for (let row = 0; row < resolution; ++row) {
        for (let col = 0; col < resolution; ++col) {
            const u = (col + 0.5) / resolution;
            const v = (row + 0.5) / resolution;
            const wx = originX + (u - 0.5) * worldSize;
            const wz = originZ + (v - 0.5) * worldSize;

            let h = 0;
            let px = wx * frequency;
            let pz = wz * frequency;
            let amp = amplitude;
            for (let o = 0; o < octaves; ++o) {
                h += valueNoise(px, pz) * amp;
                px *= 2.0;
                pz *= 2.0;
                amp *= 0.5;
            }

            bin[idx++] = h;
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
        }
    }

    const meta: HeightmapMeta = {
        version: 1,
        resolution,
        worldSize,
        originX,
        originZ,
        minHeight: minH,
        maxHeight: maxH,
    };

    return {bin, meta};
}

/**
 * Bilinear-sample a height from a baked Float32 heightmap.
 * Returns `null` when (x, z) is outside the covered region.
 */
export function sampleBakedHeight(
    x: number,
    z: number,
    data: Float32Array,
    meta: HeightmapMeta,
): number | null {
    const u = (x - meta.originX) / meta.worldSize + 0.5;
    const v = (z - meta.originZ) / meta.worldSize + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    const res = meta.resolution;
    const maxCell = res - 2;

    let gx = u * res - 0.5;
    let gz = v * res - 0.5;
    gx = Math.min(Math.max(gx, 0), maxCell + (1 - 1e-6));
    gz = Math.min(Math.max(gz, 0), maxCell + (1 - 1e-6));

    const cx = Math.min(maxCell, Math.floor(gx));
    const cz = Math.min(maxCell, Math.floor(gz));
    const fx = gx - cx;
    const fz = gz - cz;

    const i00 = cz * res + cx;
    const h00 = data[i00];
    const h10 = data[i00 + 1];
    const h01 = data[i00 + res];
    const h11 = data[i00 + res + 1];

    return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
}
