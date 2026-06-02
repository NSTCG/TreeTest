import {Component, Object3D, Mesh, MeshAttribute, MeshIndexType, property, Material, MeshComponent} from '@wonderlandengine/api';
import {vec3} from 'gl-matrix';
import {findFloatingOrigin, type FloatingOriginSource} from './floating-origin.js';
import {HeightmapMeta, sampleBakedHeight} from './heightmap-generator.js';
import {WasdMovement} from './wasd-movement.js';

const tempPos = new Float32Array(3);
const tempTex = new Float32Array(2);
const tempNorm = new Float32Array(3);

/** Heightmap texture resolution for grass grounding. */
const HEIGHTMAP_RES = 128;
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
    const v = -1.0 + 2.0 * fract(a * b * (a + b));
    return v;
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

export class Planet extends Component {
    static TypeName = 'planet';
    static UpdateAfter = [WasdMovement];

    @property.material()
    material!: Material;

    @property.int(64)
    resolution!: number;

    @property.float(200.0)
    size!: number;

    @property.float(15.0)
    amplitude!: number;

    @property.object()
    cameraObject!: Object3D;

    @property.string('')
    bakedMapUrl!: string;

    private meshComp!: MeshComponent;
    private mesh!: Mesh;
    private indexData!: Uint32Array;

    private _camPos = new Float32Array(3);
    private _logicalCamPos = new Float64Array(3);
    private _renderCenter = new Float32Array(3);
    private _lastGridX = -999999;
    private _lastGridZ = -999999;
    private _lastOriginVersion = -1;
    private _floatingOrigin: FloatingOriginSource | null = null;

    private _positions: any;
    private _normals: any;
    private _texCoords: any;
    private _terrainHeights!: Float32Array;

    /* ── Baked heightmap ── */
    private _bakedData: Float32Array | null = null;
    private _bakedMeta: HeightmapMeta | null = null;
    private _bakedReady = false;
    /** Border width (world units) for blending baked→procedural at edges */
    private static readonly BLEND_BORDER = 50;

    /* ── Heightmap texture (shared with grass shader) ── */
    private _gl!: WebGL2RenderingContext;
    private _heightTex!: WebGLTexture;
    private _heightData!: Float32Array;
    /** Current terrain center in render-space XZ, for shaders and render-space effects */
    heightmapCenterX = 0;
    heightmapCenterZ = 0;
    /** Current terrain center in logical/world XZ, for gameplay sampling */
    logicalHeightmapCenterX = 0;
    logicalHeightmapCenterZ = 0;
    /** World-space size the heightmap covers */
    heightmapWorldSize = 0;
    terrainVersion = 0;

    /** Public getter for the GPU heightmap texture */
    get heightmapTexture(): WebGLTexture { return this._heightTex; }

    start() {
        this.meshComp = this.object.addComponent('mesh')!;
        this.meshComp.material = this.material;
        this.meshComp.object.setDirty();

        const res = this.resolution;
        const vertexCount = res * res;
        const indexCount = 6 * (res - 1) * (res - 1);
        this.indexData = new Uint32Array(indexCount);
        this._terrainHeights = new Float32Array(vertexCount);
        
        let i = 0;
        for (let z = 0; z < res - 1; ++z) {
            for (let x = 0; x < res - 1; ++x) {
                const topLeft = z * res + x;
                const topRight = topLeft + 1;
                const bottomLeft = (z + 1) * res + x;
                const bottomRight = bottomLeft + 1;
                
                this.indexData[i++] = topLeft;
                this.indexData[i++] = bottomLeft;
                this.indexData[i++] = topRight;
                this.indexData[i++] = topRight;
                this.indexData[i++] = bottomLeft;
                this.indexData[i++] = bottomRight;
            }
        }

        this.mesh = this.engine.meshes.create({
            vertexCount: vertexCount,
            indexData: this.indexData,
            indexType: MeshIndexType.UnsignedInt,
        });

        this.meshComp.mesh = this.mesh;
        
        this._positions = this.mesh.attribute(MeshAttribute.Position)!;
        this._normals = this.mesh.attribute(MeshAttribute.Normal);
        this._texCoords = this.mesh.attribute(MeshAttribute.TextureCoordinate);

        /* ── Create heightmap GPU texture ── */
        this._gl = (this.engine.canvas as HTMLCanvasElement).getContext('webgl2')!;
        this._heightData = new Float32Array(HEIGHTMAP_RES * HEIGHTMAP_RES);
        this.heightmapWorldSize = this.size;

        const gl = this._gl;

        /* R32F textures need this extension for LINEAR filtering */
        const floatLinearExt = gl.getExtension('OES_texture_float_linear');
        const filterMode = floatLinearExt ? gl.LINEAR : gl.NEAREST;
        console.log('[Planet] OES_texture_float_linear:', floatLinearExt ? 'available' : 'NOT available, using NEAREST');

        /* Cache existing PBO state to prevent breaking Wonderland engine, unbind for our data upload */
        const prevUnpack = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
        const prevRowLength = gl.getParameter(gl.UNPACK_ROW_LENGTH);
        const prevSkipPixels = gl.getParameter(gl.UNPACK_SKIP_PIXELS);
        const prevSkipRows = gl.getParameter(gl.UNPACK_SKIP_ROWS);
        const prevAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);

        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

        /* Flush old errors */
        while(gl.getError() !== gl.NO_ERROR) {}

        this._heightTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, this._heightTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        /* Allocate empty texture (throws 1281 if invalid args) */
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, HEIGHTMAP_RES, HEIGHTMAP_RES, 0, gl.RED, gl.FLOAT, null);
        let glErr = gl.getError();
        if (glErr !== gl.NO_ERROR) console.error('[Planet] Error allocating texture:', glErr);

        gl.bindTexture(gl.TEXTURE_2D, null);

        /* Restore engine PBO state */
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, prevUnpack);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, prevRowLength);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, prevSkipPixels);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, prevSkipRows);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlignment);

        this.updateMesh(0, 0);
        this._updateHeightmap(0, 0);

        /* ── Load baked heightmap if URL provided ── */
        if (this.bakedMapUrl) {
            this._loadBakedHeightmap(this.bakedMapUrl);
        }
    }

    private async _loadBakedHeightmap(url: string) {
        try {
            const jsonUrl = url.replace(/\.bin$/i, '.json');
            const [binResp, jsonResp] = await Promise.all([
                fetch(url),
                fetch(jsonUrl),
            ]);
            if (!binResp.ok || !jsonResp.ok) {
                console.warn('[Planet] Failed to fetch baked heightmap:', binResp.status, jsonResp.status);
                return;
            }
            const [buf, meta] = await Promise.all([
                binResp.arrayBuffer(),
                jsonResp.json() as Promise<HeightmapMeta>,
            ]);
            this._bakedData = new Float32Array(buf);
            this._bakedMeta = meta;
            this._bakedReady = true;
            console.log(`[Planet] Baked heightmap loaded: ${meta.resolution}×${meta.resolution}, ` +
                `worldSize=${meta.worldSize}, origin=(${meta.originX}, ${meta.originZ})`);

            /* Re-generate the current chunk with baked data */
            const cellSize = this._getTerrainSpacing();
            const centerX = this._lastGridX * cellSize;
            const centerZ = this._lastGridZ * cellSize;
            this.updateMesh(centerX, centerZ);
            this._updateHeightmap(centerX, centerZ);
        } catch (e) {
            console.warn('[Planet] Error loading baked heightmap, falling back to procedural:', e);
        }
    }

    update(dt: number) {
        let cam = this.cameraObject as any;
        if (!cam && this.engine.scene.activeViews.length > 0) {
            cam = this.engine.scene.activeViews[0].object;
        }
        if (!cam) return;

        const floatingOrigin = this._getFloatingOrigin(cam);
        if (floatingOrigin) {
            floatingOrigin.getLogicalPosition(this._logicalCamPos);
        } else {
            cam.getPositionWorld(this._camPos);
            this._logicalCamPos[0] = this._camPos[0];
            this._logicalCamPos[1] = this._camPos[1];
            this._logicalCamPos[2] = this._camPos[2];
        }
        
        // Find which cell the camera is in
        const cellSize = this._getTerrainSpacing();
        const gridX = Math.floor(this._logicalCamPos[0] / cellSize);
        const gridZ = Math.floor(this._logicalCamPos[2] / cellSize);
        const originVersion = floatingOrigin?.originVersion ?? 0;

        // Render new terrain chunk around the player if cell changed
        if (gridX !== this._lastGridX || gridZ !== this._lastGridZ) {
            const centerX = gridX * cellSize;
            const centerZ = gridZ * cellSize;

            this.updateMesh(centerX, centerZ);
            this._lastGridX = gridX;
            this._lastGridZ = gridZ;
            this._updateHeightmap(centerX, centerZ);
            this._lastOriginVersion = originVersion;
        } else if (originVersion !== this._lastOriginVersion) {
            this._setRenderCenter(this.logicalHeightmapCenterX, this.logicalHeightmapCenterZ);
            this._lastOriginVersion = originVersion;
        }
    }

    getHeightAt(x: number, z: number): number {
        if (!this._bakedReady || !this._bakedData || !this._bakedMeta) {
            return this._getProceduralHeight(x, z);
        }

        const meta = this._bakedMeta;
        const halfSize = meta.worldSize * 0.5;
        const border = Planet.BLEND_BORDER;

        /* Signed distance from the edge of the baked region (positive = inside) */
        const dx = halfSize - Math.abs(x - meta.originX);
        const dz = halfSize - Math.abs(z - meta.originZ);
        const dMin = Math.min(dx, dz);

        /* Completely outside the baked region + fade border → flat */
        if (dMin < -border) return 0;

        const baked = sampleBakedHeight(x, z, this._bakedData, meta);

        /* Fully inside: use baked height directly */
        if (dMin >= border && baked !== null) return baked;

        /* In the border zone: blend between baked (or edge-clamped baked) and flat 0 */
        const t = Math.max(0, Math.min(1, (dMin + border) / (border * 2)));
        const h = baked !== null ? baked : 0;
        return h * t;
    }

    private _getProceduralHeight(x: number, z: number): number {
        let h = 0;
        let pX = x * 0.02;
        let pZ = z * 0.02;
        let amp = this.amplitude;
        for (let i = 0; i < 4; i++) {
            h += valueNoise(pX, pZ) * amp;
            pX *= 2.0;
            pZ *= 2.0;
            amp *= 0.5;
        }
        return h;
    }

    getRenderedHeightAt(x: number, z: number): number {
        return this._sampleRenderedHeightAt(
            x,
            z,
            this.logicalHeightmapCenterX,
            this.logicalHeightmapCenterZ,
        );
    }

    private updateMesh(centerX: number, centerZ: number) {
        const cellSize = this._getTerrainSpacing();
        const localStartX = -(this.size / 2.0);
        const localStartZ = -(this.size / 2.0);

        const positions = this._positions;
        const normals = this._normals;
        const texCoords = this._texCoords;

        const res = this.resolution;
        let v = 0;

        for (let z = 0; z < res; ++z) {
            for (let x = 0; x < res; ++x) {
                const localX = localStartX + x * cellSize;
                const localZ = localStartZ + z * cellSize;
                
                const worldX = centerX + localX;
                const worldZ = centerZ + localZ;
                const height = this.getHeightAt(worldX, worldZ);
                this._terrainHeights[v] = height;
                
                tempPos[0] = localX;
                tempPos[1] = height;
                tempPos[2] = localZ;
                positions.set(v, tempPos);

                if (texCoords) {
                    tempTex[0] = x / res;
                    tempTex[1] = z / res;
                    texCoords.set(v, tempTex);
                }

                v++;
            }
        }

        if (normals) {
            for (let z = 0; z < res; ++z) {
                const zPrev = Math.max(0, z - 1);
                const zNext = Math.min(res - 1, z + 1);

                for (let x = 0; x < res; ++x) {
                    const xPrev = Math.max(0, x - 1);
                    const xNext = Math.min(res - 1, x + 1);
                    const centerIndex = z * res + x;

                    const hL = this._terrainHeights[z * res + xPrev];
                    const hR = this._terrainHeights[z * res + xNext];
                    const hD = this._terrainHeights[zPrev * res + x];
                    const hU = this._terrainHeights[zNext * res + x];

                    const nx = hL - hR;
                    const ny = cellSize * 2.0;
                    const nz = hD - hU;
                    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

                    if (len > 0.0) {
                        tempNorm[0] = nx / len;
                        tempNorm[1] = ny / len;
                        tempNorm[2] = nz / len;
                    } else {
                        tempNorm[0] = 0.0;
                        tempNorm[1] = 1.0;
                        tempNorm[2] = 0.0;
                    }
                    normals.set(centerIndex, tempNorm);
                }
            }
        }

        this.mesh.update();
    }

    /** Fill the heightmap Float32 texture from CPU-side getHeightAt */
    private _updateHeightmap(centerX: number, centerZ: number) {
        this.logicalHeightmapCenterX = centerX;
        this.logicalHeightmapCenterZ = centerZ;
        this._setRenderCenter(centerX, centerZ);
        this.terrainVersion++;

        let idx = 0;
        for (let row = 0; row < HEIGHTMAP_RES; ++row) {
            for (let col = 0; col < HEIGHTMAP_RES; ++col) {
                const uvx = (col + 0.5) / HEIGHTMAP_RES;
                const uvz = (row + 0.5) / HEIGHTMAP_RES;
                const wx = centerX + (uvx - 0.5) * this.heightmapWorldSize;
                const wz = centerZ + (uvz - 0.5) * this.heightmapWorldSize;
                this._heightData[idx++] = this._sampleRenderedHeightAt(wx, wz, centerX, centerZ);
            }
        }

        /* Upload to GPU */
        const gl = this._gl;

        /* Strip engine state */
        const prevUnpack = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
        const prevRowLength = gl.getParameter(gl.UNPACK_ROW_LENGTH);
        const prevSkipPixels = gl.getParameter(gl.UNPACK_SKIP_PIXELS);
        const prevSkipRows = gl.getParameter(gl.UNPACK_SKIP_ROWS);
        const prevAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);

        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

        gl.bindTexture(gl.TEXTURE_2D, this._heightTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, HEIGHTMAP_RES, HEIGHTMAP_RES, gl.RED, gl.FLOAT, this._heightData);

        gl.bindTexture(gl.TEXTURE_2D, null);

        /* Restore engine state */
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, prevUnpack);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, prevRowLength);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, prevSkipPixels);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, prevSkipRows);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlignment);

    }

    private _getTerrainSpacing() {
        return this.resolution > 1 ? this.size / (this.resolution - 1) : this.size;
    }

    private _getFloatingOrigin(cam: Object3D | null) {
        if (this._floatingOrigin) {
            return this._floatingOrigin;
        }

        this._floatingOrigin = findFloatingOrigin(cam);
        return this._floatingOrigin;
    }

    private _setRenderCenter(centerX: number, centerZ: number) {
        const floatingOrigin = this._floatingOrigin;
        if (floatingOrigin) {
            floatingOrigin.toRenderPosition(centerX, 0.0, centerZ, this._renderCenter);
        } else {
            this._renderCenter[0] = centerX;
            this._renderCenter[1] = 0.0;
            this._renderCenter[2] = centerZ;
        }

        this.object.setPositionWorld(this._renderCenter);
        this.heightmapCenterX = this._renderCenter[0];
        this.heightmapCenterZ = this._renderCenter[2];
    }

    private _sampleRenderedHeightAt(x: number, z: number, centerX: number, centerZ: number) {
        const res = this.resolution;
        if (res < 2 || !this._terrainHeights) {
            return this.getHeightAt(x, z);
        }

        const spacing = this._getTerrainSpacing();
        const localStartX = centerX - this.size * 0.5;
        const localStartZ = centerZ - this.size * 0.5;
        const maxCell = res - 2;

        let gx = (x - localStartX) / spacing;
        let gz = (z - localStartZ) / spacing;

        gx = Math.min(Math.max(gx, 0), maxCell + (1 - 1e-6));
        gz = Math.min(Math.max(gz, 0), maxCell + (1 - 1e-6));

        const cellX = Math.min(maxCell, Math.floor(gx));
        const cellZ = Math.min(maxCell, Math.floor(gz));
        const fracX = gx - cellX;
        const fracZ = gz - cellZ;

        const topLeft = cellZ * res + cellX;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + res;
        const bottomRight = bottomLeft + 1;

        const h00 = this._terrainHeights[topLeft];
        const h10 = this._terrainHeights[topRight];
        const h01 = this._terrainHeights[bottomLeft];
        const h11 = this._terrainHeights[bottomRight];

        if (fracX + fracZ <= 1.0) {
            return h00 * (1.0 - fracX - fracZ) + h10 * fracX + h01 * fracZ;
        }

        return h10 * (1.0 - fracZ) + h01 * (1.0 - fracX) + h11 * (fracX + fracZ - 1.0);
    }
}
