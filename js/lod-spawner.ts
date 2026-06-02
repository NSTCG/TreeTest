import {Component, Object3D} from '@wonderlandengine/api';
import {property} from '@wonderlandengine/api/decorators.js';
import {findFloatingOrigin, type FloatingOriginSource} from './floating-origin.js';
import {Planet} from './planet.js';

export class LodSpawner extends Component {
    static TypeName = 'lod-spawner';
    static UpdateAfter = [Planet];

    /** The high-quality model spawned close to the camera */
    @property.object()
    prefabHigh!: Object3D;

    /** The low-quality (LOD0) model spawned far from the camera */
    @property.object()
    prefabLow!: Object3D;

    /** Total number of objects to spawn. We will clone high-quality AND low-quality models `count` times. */
    @property.int(4000)
    count!: number;

    /** The distance at which the high-quality model swaps to the LOD0 model */
    @property.float(50.0)
    lodDistance!: number;

    /** The width and depth of the square area to spawn objects randomly within */
    @property.float(200.0)
    spawnArea!: number;

    /** The camera to track. If left empty, script automatically tracks the scene's Active View */
    @property.object()
    cameraObject!: Object3D;

    /** The procedural planet mesh to walk on */
    @property.object()
    planetObject!: Object3D;

    /** Water surface height. Trees at or below this band stay hidden. */
    @property.float(0.0)
    waterLevel!: number;

    /** Extra clearance above water before trees are allowed to render. */
    @property.float(0.35)
    waterClearance!: number;

    /** Hysteresis band around the LOD switch distance to prevent flicker. */
    @property.float(8.0)
    lodHysteresis!: number;

    /** Maximum number of high-quality prefabs allowed at once. Rest are forced to low. 0 = unlimited. */
    @property.int(0)
    maxHighPrefab!: number;

    /** Vertical model offset for trees whose pivot is not exactly at the trunk base. */
    @property.float(0.0)
    groundOffset!: number;

    private _renderRoot!: Object3D;
    private _slotPool: Object3D[] = [];
    private _highMeshes: any[][] = [];
    private _lowMeshes: any[][] = [];
    private _planetComp: any = null;
    private _tempPos = new Float32Array(3);
    private _instanceScale = new Float32Array(3);
    private _prefabHighScale = new Float32Array(3);
    private _prefabLowScale = new Float32Array(3);
    private _logicalCamPos = new Float64Array(3);
    private _floatingOrigin: FloatingOriginSource | null = null;
    private _lastOriginVersion = -1;
    private _lastTerrainVersion = -1;
    
    // States cache: 0 = high-poly active, 1 = low-poly active, 2 = underwater (hidden)
    private _isLowState!: Uint8Array;
    
    // Cached positions for extreme performance overhead in Array buffering rather than WASM Object3D queries
    private _positions!: Float64Array;
    private _camPos = new Float32Array(3);

    // Scratch arrays for sorting high-prefab candidates by distance and deferred state application
    private _sortIndices!: Uint32Array;
    private _sortDists!: Float32Array;
    private _desiredState!: Uint8Array;

    start() {
        this._isLowState = new Uint8Array(this.count);
        this._positions = new Float64Array(this.count * 3);
        this._sortIndices = new Uint32Array(this.count);
        this._sortDists = new Float32Array(this.count);
        this._desiredState = new Uint8Array(this.count);
        this._renderRoot = this.engine.scene.addObject();
        this._renderRoot.setPositionWorld([0, 0, 0]);
        this._renderRoot.setRotationWorld([0, 0, 0, 1]);
        this._renderRoot.setScalingWorld([1, 1, 1]);

        if (this.planetObject) {
            this._planetComp = this.planetObject.getComponent('planet');
        }

        this.object.getScalingWorld(this._instanceScale);
        this.prefabHigh.getScalingLocal(this._prefabHighScale);
        this.prefabLow.getScalingLocal(this._prefabLowScale);

        this._floatingOrigin = this._getFloatingOrigin(this.cameraObject as any);
        this._lastOriginVersion = this._floatingOrigin?.originVersion ?? 0;
        this._lastTerrainVersion = this._planetComp?.terrainVersion ?? -1;
        this._readInitialCameraPosition();

        const gridSize = Math.ceil(Math.sqrt(this.count));
        const cellSize = this.spawnArea / gridSize;
        const halfArea = this.spawnArea / 2.0;

        // Extremely fast Seeded Random Number Generator (LCG) to ensure reproducible positions
        let seed = 1234567; // Change this integer for a different layout seed!
        const random = () => {
            seed = (seed * 1664525 + 1013904223) | 0;
            return (seed >>> 0) / 4294967296;
        };

        for (let i = 0; i < this.count; ++i) {
            const rx = i % gridSize;
            const rz = Math.floor(i / gridSize);

            // Jittered grid placement: randomizes naturally but ensures they remain distanced!
            const x = (rx * cellSize) - halfArea + (random() * cellSize);
            const z = (rz * cellSize) - halfArea + (random() * cellSize);

            // Buffer coordinate into highly performant Flat Array
            const py = this._sampleStableHeight(x, z);

            this._positions[i * 3 + 0] = x;
            this._positions[i * 3 + 1] = py;
            this._positions[i * 3 + 2] = z;

            const slot = this._renderRoot.addChild();
            const highObj = this.prefabHigh.clone(slot);
            const lowObj = this.prefabLow.clone(slot);

            this._setSlotRenderPosition(slot, x, py, z);

            // Supply random yaw rotation for organic visuals
            const yaw = random() * Math.PI * 2;
            const q = new Float32Array([0, Math.sin(yaw * 0.5), 0, Math.cos(yaw * 0.5)]);
            slot.setRotationLocal(q);

            highObj.setPositionLocal([0, 0, 0]);
            lowObj.setPositionLocal([0, 0, 0]);
            highObj.setScalingLocal([
                this._prefabHighScale[0] * this._instanceScale[0],
                this._prefabHighScale[1] * this._instanceScale[1],
                this._prefabHighScale[2] * this._instanceScale[2],
            ]);
            lowObj.setScalingLocal([
                this._prefabLowScale[0] * this._instanceScale[0],
                this._prefabLowScale[1] * this._instanceScale[1],
                this._prefabLowScale[2] * this._instanceScale[2],
            ]);

            const dx = x - this._logicalCamPos[0];
            const dz = z - this._logicalCamPos[2];
            const stateVal = this._resolveLodState(0, dx * dx + dz * dz, py);
            this._isLowState[i] = stateVal; 

            const highMeshes: any[] = [];
            this._getAllMeshComponents(highObj, highMeshes);
            const lowMeshes: any[] = [];
            this._getAllMeshComponents(lowObj, lowMeshes);

            if (stateVal === 2) {
                this._setMeshesActive(highMeshes, false);
                this._setMeshesActive(lowMeshes, false);
            } else if (stateVal === 1) {
                this._setMeshesActive(highMeshes, false);
                this._setMeshesActive(lowMeshes, true);
            } else {
                this._setMeshesActive(highMeshes, true);
                this._setMeshesActive(lowMeshes, false);
            }

            this._slotPool.push(slot);
            this._highMeshes.push(highMeshes);
            this._lowMeshes.push(lowMeshes);
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

        const camX = this._logicalCamPos[0];
        const camZ = this._logicalCamPos[2];
        const originVersion = floatingOrigin?.originVersion ?? 0;
        const originChanged = originVersion !== this._lastOriginVersion;
        this._lastOriginVersion = originVersion;
        const terrainVersion = this._planetComp?.terrainVersion ?? -1;
        const terrainChanged = terrainVersion !== this._lastTerrainVersion;
        this._lastTerrainVersion = terrainVersion;

        const distSq = this.lodDistance * this.lodDistance;
        const c = this.count;
        
        const pos = this._positions;
        const state = this._isLowState;
        const slots = this._slotPool;
        const hMeshes = this._highMeshes;
        const lMeshes = this._lowMeshes;

        const forceTransformRefresh = originChanged || terrainChanged;
        const cap = this.maxHighPrefab;
        const hasCap = cap > 0;

        // --- Pass 1: update positions/transforms and compute desired LOD states ---
        // Store desired states in _sortDists (reused as Uint8-compatible scratch)
        // and distances in _sortDists for sorting later
        let highCandidateCount = 0;

        for (let i = 0; i < c; ++i) {
            const oldPx = pos[i * 3 + 0];
            const oldPz = pos[i * 3 + 2];
            const px = this._wrapAroundCamera(oldPx, camX);
            const pz = this._wrapAroundCamera(oldPz, camZ);
            const dx = px - camX;
            const dz = pz - camZ;
            const updatedPos = Math.abs(px - oldPx) > 1e-5 || Math.abs(pz - oldPz) > 1e-5;
            let py = pos[i * 3 + 1];

            if (updatedPos || terrainChanged) {
                py = this._sampleStableHeight(px, pz);
                pos[i * 3 + 0] = px;
                pos[i * 3 + 2] = pz;
                pos[i * 3 + 1] = py;
            }

            if (updatedPos || forceTransformRefresh) {
                this._setSlotRenderPosition(slots[i], px, py, pz);
            }

            const d2 = dx * dx + dz * dz;
            const desired = this._resolveLodState(state[i], d2, py, distSq);

            // Store desired state temporarily (will be finalized after cap pass)
            this._desiredState[i] = desired;

            // Track high candidates for budget enforcement
            if (hasCap && desired === 0) {
                this._sortIndices[highCandidateCount] = i;
                this._sortDists[highCandidateCount] = d2;
                highCandidateCount++;
            }
        }

        // --- Pass 2: enforce maxHighPrefab cap ---
        if (hasCap && highCandidateCount > cap) {
            const indices = this._sortIndices;
            const dists = this._sortDists;

            // Sort high candidates by distance ascending (closest first)
            for (let i = 1; i < highCandidateCount; i++) {
                const ki = indices[i];
                const kd = dists[i];
                let j = i - 1;
                while (j >= 0 && dists[j] > kd) {
                    indices[j + 1] = indices[j];
                    dists[j + 1] = dists[j];
                    j--;
                }
                indices[j + 1] = ki;
                dists[j + 1] = kd;
            }

            // Demote all beyond budget to low
            for (let k = cap; k < highCandidateCount; k++) {
                this._desiredState[indices[k]] = 1;
            }
        }

        // --- Pass 3: apply final states, only touch engine when state actually changes ---
        for (let i = 0; i < c; ++i) {
            const nextState = this._desiredState[i];
            if (nextState !== state[i]) {
                state[i] = nextState;
                if (nextState === 2) {
                    this._setMeshesActive(hMeshes[i], false);
                    this._setMeshesActive(lMeshes[i], false);
                } else if (nextState === 1) {
                    this._setMeshesActive(hMeshes[i], false);
                    this._setMeshesActive(lMeshes[i], true);
                } else {
                    this._setMeshesActive(hMeshes[i], true);
                    this._setMeshesActive(lMeshes[i], false);
                }
            }
        }
    }

    onDestroy() {
        if (this._renderRoot && !this._renderRoot.isDestroyed) {
            this._renderRoot.destroy();
        }
    }

    private _sampleStableHeight(x: number, z: number) {
        if (!this._planetComp) {
            return 0.0;
        }

        return (
            this._planetComp.getRenderedHeightAt?.(x, z) ??
            this._planetComp.getHeightAt?.(x, z) ??
            0.0
        );
    }

    private _readInitialCameraPosition() {
        const cam = (this.cameraObject as any) ?? this.engine.scene.activeViews[0]?.object ?? null;
        if (!cam) {
            this._logicalCamPos[0] = 0.0;
            this._logicalCamPos[1] = 0.0;
            this._logicalCamPos[2] = 0.0;
            return;
        }

        if (this._floatingOrigin) {
            this._floatingOrigin.getLogicalPosition(this._logicalCamPos);
            return;
        }

        cam.getPositionWorld(this._camPos);
        this._logicalCamPos[0] = this._camPos[0];
        this._logicalCamPos[1] = this._camPos[1];
        this._logicalCamPos[2] = this._camPos[2];
    }

    private _resolveLodState(currentState: number, distanceSq: number, height: number, baseDistSq?: number) {
        if (height <= this.waterLevel + this.waterClearance) {
            return 2;
        }

        const lodDist = this.lodDistance;
        const hysteresis = Math.max(0.0, this.lodHysteresis);
        const switchToLow = (lodDist + hysteresis) * (lodDist + hysteresis);
        const switchToHigh = Math.max(0.0, lodDist - hysteresis);
        const switchToHighSq = switchToHigh * switchToHigh;
        const plainDistSq = baseDistSq ?? (lodDist * lodDist);

        if (currentState === 0) {
            return distanceSq > switchToLow ? 1 : 0;
        }

        if (currentState === 1) {
            return distanceSq < switchToHighSq ? 0 : 1;
        }

        return distanceSq > plainDistSq ? 1 : 0;
    }


    private _getAllMeshComponents(obj: Object3D, out: any[]) {
        const comps = obj.getComponents('mesh');
        for (let i = 0; i < comps.length; i++) {
            out.push(comps[i]);
        }
        const children = obj.children;
        for (let i = 0; i < children.length; i++) {
            this._getAllMeshComponents(children[i], out);
        }
    }

    private _setMeshesActive(meshes: any[], active: boolean) {
        for (let i = 0; i < meshes.length; i++) {
            meshes[i].active = active;
        }
    }

    private _wrapAroundCamera(value: number, center: number) {
        const wrapSize = this.spawnArea;
        if (wrapSize <= 0.0) {
            return value;
        }

        const halfWrap = wrapSize * 0.5;
        const offset = value - center + halfWrap;
        const wrapped = ((offset % wrapSize) + wrapSize) % wrapSize;
        return center + wrapped - halfWrap;
    }

    private _getFloatingOrigin(cam: Object3D | null) {
        if (this._floatingOrigin) {
            return this._floatingOrigin;
        }

        this._floatingOrigin = findFloatingOrigin(cam);
        return this._floatingOrigin;
    }

    private _setSlotRenderPosition(object: Object3D, x: number, y: number, z: number) {
        if (this._floatingOrigin) {
            this._floatingOrigin.toRenderPosition(x, y + this.groundOffset, z, this._tempPos);
        } else {
            this._tempPos[0] = x;
            this._tempPos[1] = y + this.groundOffset;
            this._tempPos[2] = z;
        }

        object.setPositionLocal(this._tempPos);
    }
}
