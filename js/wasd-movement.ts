import {Component, Type, Object3D} from "@wonderlandengine/api";
import {vec3, quat} from "gl-matrix";
import {getActiveFloatingOrigin, setActiveFloatingOrigin} from "./floating-origin.js";


/**
 * Frame-rate independent WASD + QE movement with Momentum, Double-Precision positioning
 * perfectly countering jitter at high coordinates, and an integrated Orbital/First-Person Camera.
 * Completely equipped for VR headsets with seamless handoff logic.
 */
export class WasdMovement extends Component {
    static TypeName = "wasd-movement";
    static Properties = {
        /** Peak movement speed in metres per second */
        speed: {type: Type.Float, default: 5.0},
        /** Sprint multiplier (applied while holding Shift) */
        sprintMultiplier: {type: Type.Float, default: 2.0},
        /** Rate of velocity gain */
        acceleration: {type: Type.Float, default: 50.0},
        /** Rate of velocity frictional decay */
        damping: {type: Type.Float, default: 10.0},
        /** Constrain movement force to the global XZ plane */
        lockY: {type: Type.Bool, default: true},
        /** The Camera or Head. It receives Pitch/Yaw rotation, and optionally TPP Zoom offset */
        headObject: {type: Type.Object},
        /** Optional VR Camera to automatically take over upon XR Session start */
        vrCamera: {type: Type.Object},
        mouseSensitivity: {type: Type.Float, default: 0.2},
        zoomSensitivity: {type: Type.Float, default: 0.02},
        /** TPP Camera offset distance */
        startZoom: {type: Type.Float, default: 5.0},
        minZoom: {type: Type.Float, default: 0.0},
        maxZoom: {type: Type.Float, default: 30.0},
        /** True to only allow view movement upon click dragging */
        requireMouseDown: {type: Type.Bool, default: true},
        /** Activate Pointer Lock over canvas upon clicking */
        pointerLockOnClick: {type: Type.Bool, default: false},
        /** The procedural planet mesh to walk on */
        planetObject: {type: Type.Object},
        /** If planetObject is assigned, what is the eye level offset to remain above the terrain? */
        playerHeight: {type: Type.Float, default: 1.6},
        /** Render-space recenter distance before the world is shifted back near the origin */
        floatingOriginThreshold: {type: Type.Float, default: 512.0},
    };

    /* -- Declared by Properties -- */
    speed!: number;
    sprintMultiplier!: number;
    acceleration!: number;
    damping!: number;
    lockY!: boolean;
    headObject!: Object3D;
    vrCamera!: Object3D;
    mouseSensitivity!: number;
    zoomSensitivity!: number;
    startZoom!: number;
    minZoom!: number;
    maxZoom!: number;
    requireMouseDown!: boolean;
    pointerLockOnClick!: boolean;
    planetObject!: Object3D;
    playerHeight!: number;
    floatingOriginThreshold!: number;

    /* -- Internal Inputs & States -- */
    private _keys = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        up: false,      
        down: false,     
        sprint: false,   
    };

    private _inVR = false;
    private _selectPressed = false;
    private _defaultHeadObject!: Object3D;
    private _planetComp: any = null;

    /** Fixed timestep for the movement physics simulation (1/60 s) */
    private readonly FIXED_DT = 1 / 60;
    private _accumulator = 0;

    /* -- Highly precise physics accumulation countering extreme-origin precision errors -- */
    private _position64 = new Float64Array(3);
    private _velocity64 = new Float64Array(3);
    private _renderOrigin64 = new Float64Array(3);
    private _originVersion = 0;

    /* -- Integrated Camera View Tracking -- */
    private _yaw = 0;
    private _pitch = 0;
    private _zoom = 5.0;
    private _mouseDown = false;

    /* Vectors */
    private _orbitOffset = new Float32Array(3);
    private _camPos = new Float32Array(3);
    private _renderPlayerPos = new Float32Array(3);
    private _zoomScale = new Float32Array(3);
    private _quat = new Float32Array(4);
    private _tempFwd = new Float32Array(3);
    /** Smoothed camera Y for terrain clamping */
    private _smoothCamY = -Infinity;
    /** Minimum clearance above terrain for the camera */
    private readonly CAM_TERRAIN_CLEARANCE = 0.5;

    start() {
        this.headObject = (this.headObject as any) || this.object;
        this._defaultHeadObject = this.headObject;
        setActiveFloatingOrigin(this);

        if (this.planetObject) {
            this._planetComp = this.planetObject.getComponent('planet');
        }

        // Take initial exact position
        const pos32 = this.object.getPositionWorld(new Float32Array(3));
        this._position64[0] = pos32[0];
        this._position64[1] = pos32[1];
        this._position64[2] = pos32[2];
        this._renderOrigin64[0] = this._position64[0];
        this._renderOrigin64[2] = this._position64[2];
        this._originVersion = 1;

        this._zoom = this.startZoom;

        // Check intrinsic pivot-to-camera mounting distance 
        if (this.headObject !== this.object) {
            this.headObject.getPositionLocal(this._orbitOffset);
        } else {
            this._orbitOffset[0] = 0;
            this._orbitOffset[1] = 0;
            this._orbitOffset[2] = 0;
        }

        // Establish rotational offsets from scene starting posture
        const fwd = new Float32Array(3);
        this.headObject.getForwardWorld(fwd);
        this._yaw = Math.atan2(-fwd[0], -fwd[2]) * 180 / Math.PI; 
        this._pitch = Math.asin(fwd[1]) * 180 / Math.PI;

        this._updateHead();
    }

    get originVersion() {
        return this._originVersion;
    }

    getLogicalPosition(out: Float32Array | Float64Array) {
        out[0] = this._position64[0];
        out[1] = this._position64[1];
        out[2] = this._position64[2];
        return out;
    }

    toRenderPosition(x: number, y: number, z: number, out: Float32Array) {
        out[0] = x - this._renderOrigin64[0];
        out[1] = y;
        out[2] = z - this._renderOrigin64[2];
        return out;
    }

    onActivate() {
        setActiveFloatingOrigin(this);
        window.addEventListener("keydown", this._onKeyDown);
        window.addEventListener("keyup",   this._onKeyUp);

        const canvas = this.engine.canvas;
        document.addEventListener('mousemove', this._onMouseMove);
        
        if (this.pointerLockOnClick) {
            canvas.addEventListener('mousedown', this._requestPointerLock);
        }
        if (this.requireMouseDown) {
            canvas.addEventListener('contextmenu', this._preventDefault, { passive: false });
            canvas.addEventListener('mousedown', this._onMouseDown);
            window.addEventListener('mouseup', this._onMouseUp);
        }
        canvas.addEventListener('wheel', this._onMouseScroll, { passive: false });
        
        this.engine.onXRSessionStart.add(this._onXRSessionStart);
        this.engine.onXRSessionEnd.add(this._onXRSessionEnd);
    }

    onDeactivate() {
        if (getActiveFloatingOrigin() === this) {
            setActiveFloatingOrigin(null);
        }

        window.removeEventListener("keydown", this._onKeyDown);
        window.removeEventListener("keyup",   this._onKeyUp);

        const canvas = this.engine.canvas;
        document.removeEventListener('mousemove', this._onMouseMove);
        
        if (this.pointerLockOnClick) {
            canvas.removeEventListener('mousedown', this._requestPointerLock);
        }
        if (this.requireMouseDown) {
            canvas.removeEventListener('contextmenu', this._preventDefault);
            canvas.removeEventListener('mousedown', this._onMouseDown);
            window.removeEventListener('mouseup', this._onMouseUp);
        }
        canvas.removeEventListener('wheel', this._onMouseScroll);

        this.engine.onXRSessionStart.remove(this._onXRSessionStart);
        this.engine.onXRSessionEnd.remove(this._onXRSessionEnd);

        const k = this._keys;
        k.forward = k.backward = k.left = k.right = k.up = k.down = k.sprint = false;
        this._mouseDown = false;
        this._selectPressed = false;
    }

    onDestroy() {
        if (getActiveFloatingOrigin() === this) {
            setActiveFloatingOrigin(null);
        }
    }

    /* ══════════════════════════════════════════════
     *  VR Session Events
     * ══════════════════════════════════════════════ */
    private _onXRSessionStart = (session: any) => {
        this._inVR = true;
        if (this.vrCamera) {
            this.headObject = this.vrCamera;
        }
        session.addEventListener('selectstart', this._onSelectStart);
        session.addEventListener('selectend', this._onSelectEnd);
    };

    private _onXRSessionEnd = () => {
        this._inVR = false;
        this.headObject = this._defaultHeadObject;
        this._selectPressed = false;
    };

    private _onSelectStart = () => { this._selectPressed = true; };
    private _onSelectEnd = () => { this._selectPressed = false; };

    /* ══════════════════════════════════════════════
     *  Fixed-timestep Physics + Precision Logic
     * ══════════════════════════════════════════════ */
    update(dt: number) {
        dt = Math.min(dt, this.FIXED_DT * 5); // 83ms hitch clamp
        this._accumulator += dt;

        while (this._accumulator >= this.FIXED_DT) {
            this._accumulator -= this.FIXED_DT;
            this._fixedStep(this.FIXED_DT);
        }

        // Render orientation + position every visual frame optimally
        this._updateHead();
    }

    private _fixedStep(sdt: number) {
        const k = this._keys;
        let inputX = 0, inputY = 0, inputZ = 0;

        if (k.forward || this._selectPressed)  inputZ -= 1.0;
        if (k.backward) inputZ += 1.0;
        if (k.left)     inputX -= 1.0;
        if (k.right)    inputX += 1.0;
        
        if (!this.lockY) {
            if (k.up)   inputY += 1.0;
            if (k.down) inputY -= 1.0;
        }

        const inputMag = Math.sqrt(inputX*inputX + inputZ*inputZ + inputY*inputY);
        if (inputMag > 0) {
            inputX /= inputMag;
            inputZ /= inputMag;
            inputY /= inputMag;
        }

        // Project inputs relative to the Yaw viewing orientation
        const yawRad = this._yaw * (Math.PI / 180);
        const cosY = Math.cos(yawRad);
        const sinY = Math.sin(yawRad);

        const localDirX = inputX * cosY + inputZ * sinY;
        const localDirZ = -inputX * sinY + inputZ * cosY;
        const localDirY = inputY;

        const spd = this.speed * (k.sprint ? this.sprintMultiplier : 1.0);
        const targetVX = localDirX * spd;
        const targetVY = (this.lockY ? 0.0 : localDirY) * spd;
        const targetVZ = localDirZ * spd;

        // Physics Momentum Calculation: Decay / Acceleration
        const blendAccel = 1.0 - Math.exp(-this.acceleration * sdt);
        const blendDamp  = 1.0 - Math.exp(-this.damping * sdt);
        
        const blendX = (targetVX !== 0) ? blendAccel : blendDamp;
        const blendY = (targetVY !== 0) ? blendAccel : blendDamp;
        const blendZ = (targetVZ !== 0) ? blendAccel : blendDamp;

        this._velocity64[0] += (targetVX - this._velocity64[0]) * blendX;
        this._velocity64[1] += (targetVY - this._velocity64[1]) * blendY;
        this._velocity64[2] += (targetVZ - this._velocity64[2]) * blendZ;

        // Incorporate onto the uncompromised pristine floating coordinate plane
        this._position64[0] += this._velocity64[0] * sdt;
        this._position64[1] += this._velocity64[1] * sdt;
        this._position64[2] += this._velocity64[2] * sdt;

        // Snapping to infinite terrain (up and down)
        if (this._planetComp) {
            const tx = this._position64[0];
            const tz = this._position64[2];
            const h = this._planetComp.getRenderedHeightAt?.(tx, tz)
                ?? this._planetComp.getHeightAt(tx, tz);
            this._position64[1] = h + this.playerHeight;
            this._velocity64[1] = 0;
        }

        this._maybeShiftRenderOrigin();
    }

    private _updateHead() {
        this.toRenderPosition(
            this._position64[0],
            this._position64[1],
            this._position64[2],
            this._renderPlayerPos,
        );

        if (this.headObject !== this.object) {
            this.object.setPositionWorld(this._renderPlayerPos);
        }

        // If in VR, halt manual cursor camera math and inherit WebXR Headset space!
        if (this._inVR) {
            this.headObject.getForwardWorld(this._tempFwd);
            this._yaw = Math.atan2(-this._tempFwd[0], -this._tempFwd[2]) * 180 / Math.PI; 
            this._pitch = Math.asin(this._tempFwd[1]) * 180 / Math.PI;
            return; 
        }

        quat.fromEuler(this._quat, this._pitch, this._yaw, 0);
        this.headObject.setRotationWorld(this._quat);

        // Center on pivot
        this._camPos[0] = this._renderPlayerPos[0] + this._orbitOffset[0];
        this._camPos[1] = this._renderPlayerPos[1] + this._orbitOffset[1];
        this._camPos[2] = this._renderPlayerPos[2] + this._orbitOffset[2];
        this._zoomScale[0] = 0;
        this._zoomScale[1] = 0;
        this._zoomScale[2] = 0;

        // Perform TPP Camera displacement orbit if configured
        if (this._zoom > 0.001) {
            this._zoomScale[2] = this._zoom;
            vec3.transformQuat(this._zoomScale, this._zoomScale, this._quat);

            this._camPos[0] += this._zoomScale[0];
            this._camPos[1] += this._zoomScale[1];
            this._camPos[2] += this._zoomScale[2];
        }

        // Clamp camera above terrain
        if (this._planetComp) {
            const camX = this._position64[0] + this._orbitOffset[0] + this._zoomScale[0];
            const camZ = this._position64[2] + this._orbitOffset[2] + this._zoomScale[2];
            const terrainH = this._planetComp.getRenderedHeightAt?.(camX, camZ)
                ?? this._planetComp.getHeightAt(camX, camZ);
            const minY = terrainH + this.CAM_TERRAIN_CLEARANCE;
            if (this._camPos[1] < minY) {
                // Smooth lerp so camera slides along terrain instead of snapping
                if (this._smoothCamY === -Infinity) this._smoothCamY = minY;
                this._smoothCamY += (minY - this._smoothCamY) * Math.min(1.0, 12.0 * this.FIXED_DT);
                this._camPos[1] = this._smoothCamY;
            } else {
                this._smoothCamY = this._camPos[1];
            }
        }

        this.headObject.setPositionWorld(this._camPos);
    }

    private _maybeShiftRenderOrigin() {
        if (this.floatingOriginThreshold <= 0.0) {
            return;
        }

        const dx = this._position64[0] - this._renderOrigin64[0];
        const dz = this._position64[2] - this._renderOrigin64[2];
        const thresholdSq = this.floatingOriginThreshold * this.floatingOriginThreshold;

        if ((dx * dx + dz * dz) < thresholdSq) {
            return;
        }

        this._renderOrigin64[0] = this._position64[0];
        this._renderOrigin64[2] = this._position64[2];
        this._originVersion++;
    }

    /* ── DOM Events ── */
    private _preventDefault = (e: Event) => e.preventDefault();
    private _requestPointerLock = () => {
        const canvas = this.engine.canvas;
        if (canvas.requestPointerLock) canvas.requestPointerLock();
    };

    private _onMouseDown = (e: MouseEvent) => {
        if (e.button === 1) {
            e.preventDefault();
            return;
        }
        if (e.button === 0 || e.button === 2) {
            this._mouseDown = true;
            document.body.style.cursor = 'grabbing';
        }
    };
    
    private _onMouseUp = (e: MouseEvent) => {
        if (e.button === 0 || e.button === 2) {
            this._mouseDown = false;
            document.body.style.cursor = 'initial';
        }
    };

    private _onMouseMove = (e: MouseEvent) => {
        const isPointerLocked = (document.pointerLockElement === this.engine.canvas);
        if (this.active && (this._mouseDown || !this.requireMouseDown || isPointerLocked)) {
            this._yaw -= e.movementX * this.mouseSensitivity;
            this._pitch -= e.movementY * this.mouseSensitivity;
            this._pitch = Math.max(-89, Math.min(89, this._pitch));
        }
    };

    private _onMouseScroll = (e: WheelEvent) => {
        e.preventDefault();
        // Downward vertical scaling shifts backwards creating Zoom Out expansion
        this._zoom += Math.sign(e.deltaY) * this.zoomSensitivity * 10.0;
        this._zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this._zoom));
    };

    private _onKeyDown = (e: KeyboardEvent) => { this._setKey(e, true);  };
    private _onKeyUp   = (e: KeyboardEvent) => { this._setKey(e, false); };
    private _setKey(e: KeyboardEvent, pressed: boolean) {
        switch (e.code) {
            case "KeyW": case "ArrowUp":    this._keys.forward  = pressed; break;
            case "KeyS": case "ArrowDown":  this._keys.backward = pressed; break;
            case "KeyA": case "ArrowLeft":  this._keys.left     = pressed; break;
            case "KeyD": case "ArrowRight": this._keys.right    = pressed; break;
            case "KeyQ":                    this._keys.up       = pressed; break;
            case "KeyE":                    this._keys.down     = pressed; break;
            case "ShiftLeft": case "ShiftRight": this._keys.sprint = pressed; break;
            default: return;
        }
    }
}
