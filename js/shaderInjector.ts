import {Component} from "@wonderlandengine/api";
import {Planet} from "./planet.js";

/** Per-program uniform location cache */
interface ProgramUniforms {
    uTime: WebGLUniformLocation | null;
    uIsUnderwater: WebGLUniformLocation | null;
    uHeightMap: WebGLUniformLocation | null;
    uHeightmapCenter: WebGLUniformLocation | null;
    uHeightmapSize: WebGLUniformLocation | null;
}

/** All uniform names we want to look up for every linked program */
const UNIFORM_NAMES: (keyof ProgramUniforms)[] = [
    'uTime',
    'uIsUnderwater',
    'uHeightMap',
    'uHeightmapCenter',
    'uHeightmapSize',
];

/** Map from our key names to the actual GLSL uniform names in shaders */
const UNIFORM_GLSL_NAMES: Record<keyof ProgramUniforms, string> = {
    uTime:            'u_time',
    uIsUnderwater:    'uIsUnderwater',
    uHeightMap:       'u_heightMap',
    uHeightmapCenter: 'u_heightmapCenter',
    uHeightmapSize:   'u_heightmapSize',
};

export class PostProcessing extends Component {
    static TypeName = "postprocessing-injector";

    /** Every linked program gets its own uniform location map */
    _programs = new Map<WebGLProgram, ProgramUniforms>();

    private _tempVec = new Float32Array(3);
    private _planet: Planet | null = null;

    /** Texture unit reserved for the heightmap (high to avoid engine conflicts) */
    private static readonly HEIGHTMAP_TEX_UNIT = 7;

    init() {
        const gl = this.engine.canvas.getContext("webgl2")!;

        /* ─────────────────────────────────────────────
         *  SHADER SOURCE – intercept meshlet vertex shaders and inject LOD
         * ───────────────────────────────────────────── */
        const origShaderSource = gl.shaderSource.bind(gl);
        gl.shaderSource = (shader: WebGLShader, source: string) => {
            if (
                source.includes("inMeshletData") &&
                source.includes("gl_Position") &&
                !source.includes("viewWorldPosition[4]")
            ) {
                console.log("[MeshletLOD] Intercepted meshlet vertex shader — injecting distance LOD");
                source = this._injectMeshletLOD(source);
            }

            console.log("Shader Source:", shader, source);
            origShaderSource(shader, source);
        };

        /* ─────────────────────────────────────────────
         *  LINK PROGRAM – look up ALL uniform locations independently
         *  Every program is tracked regardless of which uniforms it has.
         * ───────────────────────────────────────────── */
        const origLinkProgram = gl.linkProgram.bind(gl);
        gl.linkProgram = (program: WebGLProgram) => {
            origLinkProgram(program);

            const locs: ProgramUniforms = {
                uTime: null,
                uIsUnderwater: null,
                uHeightMap: null,
                uHeightmapCenter: null,
                uHeightmapSize: null,
            };

            let hasAny = false;
            for (const key of UNIFORM_NAMES) {
                const loc = gl.getUniformLocation(program, UNIFORM_GLSL_NAMES[key]);
                if (loc) {
                    locs[key] = loc;
                    hasAny = true;
                }
            }

            if (hasAny) {
                this._programs.set(program, locs);
            }
        };

        /* ─────────────────────────────────────────────
         *  USE PROGRAM – set each uniform independently
         * ───────────────────────────────────────────── */
        const origUseProgram = gl.useProgram.bind(gl);
        gl.useProgram = (program: WebGLProgram | null) => {
            origUseProgram(program);

            if (program && this._programs.has(program)) {
                const gl2 = this.engine.canvas.getContext("webgl2")!;
                this._updateUniforms(gl2, this._programs.get(program)!);
            }
        };

        /* ─────────────────────────────────────────────
         *  DELETE PROGRAM – cleanup
         * ───────────────────────────────────────────── */
        const origDeleteProgram = gl.deleteProgram.bind(gl);
        gl.deleteProgram = (program: WebGLProgram | null) => {
            if (program) this._programs.delete(program);
            origDeleteProgram(program);
        };
    }

    /* ══════════════════════════════════════════════════════════════
     *  Find the Planet component (lazy, cached)
     * ══════════════════════════════════════════════════════════════ */
    private _findPlanet(): Planet | null {
        if (this._planet) return this._planet;
        for (const obj of this.engine.scene.children) {
            this._planet = this._searchPlanet(obj);
            if (this._planet) return this._planet;
        }
        return null;
    }

    private _searchPlanet(obj: any): Planet | null {
        const comp = obj.getComponent('planet');
        if (comp) return comp as unknown as Planet;
        if (obj.children) {
            for (const child of obj.children) {
                const found = this._searchPlanet(child);
                if (found) return found;
            }
        }
        return null;
    }

    /* ══════════════════════════════════════════════════════════════
     *  INJECT DISTANCE-BASED LOD INTO MESHLET VERTEX SHADER
     * ══════════════════════════════════════════════════════════════ */
    _injectMeshletLOD(source: string): string {
        const anchor =
            "fragPositionWorld = quat2_transformPoint(Quat2(transform[0], transform[1]), scaling.xyz*inPosition);";

        if (!source.includes(anchor)) {
            console.warn("[MeshletLOD] ⚠ injection anchor not found — shader unchanged!");
            return source;
        }

        const lodGLSL = `fragPositionWorld = quat2_transformPoint(Quat2(transform[0], transform[1]), scaling.xyz*inPosition);

    /* ── Distance-based meshlet LOD (injected) ── */
    {
        highp float _lodDist = distance(fragPositionWorld, viewWorldPosition[viewIndex]);
        int _triIdx = gl_VertexID / 3;

        bool _cull = false;
        if (_lodDist > 30.0) {
            _cull = (_triIdx & 7) != 0;   /* keep every 8th tri  ~12% */
        } else if (_lodDist > 20.0) {
            _cull = (_triIdx & 3) != 0;   /* keep every 4th tri  ~25% */
        } else if (_lodDist > 10.0) {
            _cull = (_triIdx & 1) != 0;   /* keep every 2nd tri  ~50% */
        }

        if (_cull) {
            gl_Position = vec4(uintBitsToFloat(0x7fc00000u));
            return;
        }
    }`;

        const modified = source.replace(anchor, lodGLSL);
        console.log("[MeshletLOD] ✓ LOD code injected successfully");
        return modified;
    }

    /* ══════════════════════════════════════════════════════════════
     *  SET PER-FRAME UNIFORMS — each one independently
     * ══════════════════════════════════════════════════════════════ */
    _updateUniforms(gl: WebGL2RenderingContext, locs: ProgramUniforms) {

        /* ── u_time ── */
        if (locs.uTime) {
            gl.uniform1f(locs.uTime, performance.now() / 1000.0);
        }

        /* ── uIsUnderwater ── */
        if (locs.uIsUnderwater) {
            const cam = this.engine.scene.mainView?.object;
            if (cam) {
                cam.getPositionWorld(this._tempVec);
                gl.uniform1f(locs.uIsUnderwater, this._tempVec[1] < -0.5 ? 1.0 : 0.0);
            }
        }

        /* ── u_heightMap + u_heightmapCenter + u_heightmapSize ── */
        if (locs.uHeightMap) {
            const planet = this._findPlanet();
            if (planet && planet.heightmapTexture) {
                const unit = PostProcessing.HEIGHTMAP_TEX_UNIT;
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, planet.heightmapTexture);
                gl.uniform1i(locs.uHeightMap, unit);
            }
        }
        if (locs.uHeightmapCenter) {
            const planet = this._findPlanet();
            if (planet) {
                gl.uniform2f(locs.uHeightmapCenter, planet.heightmapCenterX, planet.heightmapCenterZ);
            }
        }
        if (locs.uHeightmapSize) {
            const planet = this._findPlanet();
            if (planet) {
                gl.uniform1f(locs.uHeightmapSize, planet.heightmapWorldSize);
            }
        }
    }
}
