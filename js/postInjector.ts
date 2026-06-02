import {Component} from "@wonderlandengine/api";
import {Planet} from "./planet.js";

interface ProgramUniforms {
    uTime: WebGLUniformLocation | null;
    uIsUnderwater: WebGLUniformLocation | null;
    uHeightmapTexture: WebGLUniformLocation | null;
    uHeightmapCenter: WebGLUniformLocation | null;
    uHeightmapSize: WebGLUniformLocation | null;
    uWorldOriginOffset: WebGLUniformLocation | null;
    uGridWrapSize: WebGLUniformLocation | null;
    uPlayerPosition: WebGLUniformLocation | null;
}

const UNIFORM_GLSL_NAMES: Record<keyof ProgramUniforms, string> = {
    uTime: "u_time",
    uIsUnderwater: "uIsUnderwater",
    uHeightmapTexture: "u_heightmapTexture",
    uHeightmapCenter: "u_heightmapCenter",
    uHeightmapSize: "u_heightmapSize",
    uWorldOriginOffset: "u_worldOriginOffset",
    uGridWrapSize: "u_gridWrapSize",
    uPlayerPosition: "u_playerPosition",
};

function hasTrackedUniform(locs: ProgramUniforms) {
    return Object.values(locs).some((loc) => loc !== null);
}

export class PostInjector extends Component {
    static TypeName = "PostInjector";
    private static readonly HEIGHTMAP_TEX_UNIT = 15;
    private static readonly DEFAULT_GRASS_WRAP_SIZE = 200.0;

    private _gl: WebGL2RenderingContext | null = null;
    private _trackedPrograms = new Set<WebGLProgram>();
    private _programUniforms = new Map<WebGLProgram, ProgramUniforms>();
    private _tempVec = new Float32Array(3);
    private _planet: Planet | null = null;
    private _grass: any | null = null;
    private _currentProgram: WebGLProgram | null = null;

    private _oldShaderSource: ((shader: WebGLShader, source: string) => void) | null = null;
    private _oldCreateProgram: (() => WebGLProgram | null) | null = null;
    private _oldLinkProgram: ((program: WebGLProgram) => void) | null = null;
    private _oldUseProgram: ((program: WebGLProgram | null) => void) | null = null;
    private _oldDeleteProgram: ((program: WebGLProgram | null) => void) | null = null;

    init() {
        const gl = this.engine.canvas.getContext("webgl2");
        if (!gl) {
            console.error("[PostInjector] WebGL2 context unavailable.");
            return;
        }
        this._gl = gl;

        const customFragSrc = `#version 300 es

uniform mediump sampler2D sceneTexture;
//uniform mediump float u_time;
//uniform mediump float uIsUnderwater;
in mediump vec2 textureCoordinates;
out mediump vec4 outColor;

// uniform BloomUniforms {
//     lowp uint flags;
// };

void main() {
    // if ((flags & (1u << 3u)) != 0u) {
    //     mediump vec2 uv = textureCoordinates;
    //     mediump vec4 color;

    //     if (uIsUnderwater > 0.5) {
    //         mediump float waveA = sin(uv.y * 10.0 + u_time * 1.0);
    //         mediump float waveB = sin(uv.y * 17.0 - u_time * 1.45 + uv.x * 2.5);
    //         mediump float waveC = cos(uv.x * 7.0 + u_time * 0.65);
    //         mediump float swell = sin((uv.x + uv.y) * 5.0 + u_time * 0.4);
    //         uv.x += (waveA + waveB) * 0.0029 + swell * 0.0009;
    //         uv.y += waveC * 0.0012;
    //         uv = clamp(uv, vec2(0.001), vec2(0.999));

    //         mediump vec2 centeredUv = uv - vec2(0.5);
    //         mediump vec2 chromaOffset = centeredUv * 0.012;
    //         mediump vec2 uvR = clamp(uv + chromaOffset, vec2(0.001), vec2(0.999));
    //         mediump vec2 uvB = clamp(uv - chromaOffset, vec2(0.001), vec2(0.999));

    //         color = vec4(
    //             texture(sceneTexture, uvR).r,
    //             texture(sceneTexture, uv).g,
    //             texture(sceneTexture, uvB).b,
    //             texture(sceneTexture, uv).a
    //         );

    //         mediump float vignette = 1.0 - smoothstep(0.18, 0.72, dot(centeredUv, centeredUv) * 2.0);
    //         color.rgb *= mix(0.82, 1.0, vignette);
    //         color.rgb *= vec3(0.96, 0.99, 1.04);
    //     } else {
    //         color = texture(sceneTexture, uv).rgba;
    //     }

    //     // mediump vec2 bloomOffset = vec2(0.0055);
    //     // mediump vec3 bloomSample = (
    //     //     color.rgb * 2.0 +
    //     //     texture(sceneTexture, clamp(uv + vec2(bloomOffset.x, 0.0), vec2(0.001), vec2(0.999))).rgb +
    //     //     texture(sceneTexture, clamp(uv - vec2(bloomOffset.x, 0.0), vec2(0.001), vec2(0.999))).rgb +
    //     //     texture(sceneTexture, clamp(uv + vec2(0.0, bloomOffset.y), vec2(0.001), vec2(0.999))).rgb +
    //     //     texture(sceneTexture, clamp(uv - vec2(0.0, bloomOffset.y), vec2(0.001), vec2(0.999))).rgb
    //     // ) / 6.0;
    //     // mediump float bloomBrightness = dot(bloomSample, vec3(0.2126, 0.7152, 0.0722));
    //     // mediump float bloomMask = smoothstep(0.45, 0.9, bloomBrightness);
    //     // color.rgb += bloomSample * bloomMask * mix(0.18, 0.28, uIsUnderwater);

    //     outColor = color;
    // } else {
    //     outColor = vec4(0.0);
    // }

    outColor = texture(sceneTexture, textureCoordinates);
}
`;

        this._oldShaderSource = gl.shaderSource.bind(gl);
        gl.shaderSource = (shader: WebGLShader, source: string) => {
            if (source.includes("sceneTexture") && source.includes("bloomTexture")) {
                source = customFragSrc;
            }
            this._oldShaderSource?.(shader, source);
        };

        this._oldCreateProgram = gl.createProgram.bind(gl);
        gl.createProgram = () => {
            const program = this._oldCreateProgram?.() ?? null;
            if (program) this._trackedPrograms.add(program);
            return program;
        };

        this._oldLinkProgram = gl.linkProgram.bind(gl);
        gl.linkProgram = (program: WebGLProgram) => {
            this._oldLinkProgram?.(program);
            this._trackedPrograms.add(program);
            this._cacheProgramUniforms(program);
        };

        this._oldUseProgram = gl.useProgram.bind(gl);
        gl.useProgram = (program: WebGLProgram | null) => {
            this._oldUseProgram?.(program);
            this._currentProgram = program;
            if (program) {
                this._trackedPrograms.add(program);
                const locs = this._cacheProgramUniforms(program);
                if (hasTrackedUniform(locs)) {
                    this._updateUniforms(gl, locs, this._findPlanet());
                }
            }
        };

        this._oldDeleteProgram = gl.deleteProgram ? gl.deleteProgram.bind(gl) : null;
        if (this._oldDeleteProgram) {
            gl.deleteProgram = (program: WebGLProgram | null) => {
                if (program) {
                    this._trackedPrograms.delete(program);
                    this._programUniforms.delete(program);
                }
                return this._oldDeleteProgram?.(program);
            };
        }
    }

    update() {
        const gl = this._gl;
        if (!gl) return;

        const planet = this._findPlanet();
        const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;

        if (planet && planet.heightmapTexture) {
            gl.activeTexture(gl.TEXTURE0 + PostInjector.HEIGHTMAP_TEX_UNIT);
            gl.bindSampler(PostInjector.HEIGHTMAP_TEX_UNIT, null);
            gl.bindTexture(gl.TEXTURE_2D, planet.heightmapTexture);
        }

        const currentProgram = this._currentProgram;
        if (currentProgram) {
            const locs = this._cacheProgramUniforms(currentProgram);
            if (hasTrackedUniform(locs)) {
                this._updateUniforms(gl, locs, planet);
            }
        }

        gl.activeTexture(previousActiveTexture);
    }

    onDestroy() {
        const gl = this._gl;
        if (!gl) return;

        if (this._oldShaderSource) gl.shaderSource = this._oldShaderSource;
        if (this._oldCreateProgram) gl.createProgram = this._oldCreateProgram;
        if (this._oldLinkProgram) gl.linkProgram = this._oldLinkProgram;
        if (this._oldUseProgram) gl.useProgram = this._oldUseProgram;
        if (this._oldDeleteProgram) gl.deleteProgram = this._oldDeleteProgram;

        this._trackedPrograms.clear();
        this._programUniforms.clear();
        this._planet = null;
        this._currentProgram = null;
        this._gl = null;
    }

    private _cacheProgramUniforms(program: WebGLProgram) {
        const gl = this._gl;
        if (!gl) {
            return {
                uTime: null,
                uIsUnderwater: null,
                uHeightmapTexture: null,
                uHeightmapCenter: null,
                uHeightmapSize: null,
                uWorldOriginOffset: null,
                uGridWrapSize: null,
                uPlayerPosition: null,
            };
        }

        const cached = this._programUniforms.get(program);
        if (cached) return cached;

        const locs: ProgramUniforms = {
            uTime: null,
            uIsUnderwater: null,
            uHeightmapTexture: null,
            uHeightmapCenter: null,
            uHeightmapSize: null,
            uWorldOriginOffset: null,
            uGridWrapSize: null,
            uPlayerPosition: null,
        };

        for (const key of Object.keys(UNIFORM_GLSL_NAMES) as (keyof ProgramUniforms)[]) {
            locs[key] = gl.getUniformLocation(program, UNIFORM_GLSL_NAMES[key]);
        }

        this._programUniforms.set(program, locs);
        return locs;
    }

    private _findPlanet(): Planet | null {
        if (this._planet) return this._planet;

        for (const obj of this.engine.scene.children) {
            this._planet = this._searchComponent(obj, "planet") as Planet | null;
            if (this._planet) return this._planet;
        }

        return null;
    }

    private _findGrass() {
        if (this._grass) return this._grass;

        for (const obj of this.engine.scene.children) {
            this._grass = this._searchComponent(obj, "simpleCircularGrass");
            if (this._grass) return this._grass;
        }

        return null;
    }

    private _searchComponent(obj: any, typeName: string) {
        const comp = obj.getComponent(typeName);
        if (comp) return comp;

        if (obj.children) {
            for (const child of obj.children) {
                const found = this._searchComponent(child, typeName);
                if (found) return found;
            }
        }

        return null;
    }

    private _updateUniforms(
        gl: WebGL2RenderingContext,
        locs: ProgramUniforms,
        planet: Planet | null,
    ) {
        const grass = this._findGrass();

        if (locs.uTime) {
            gl.uniform1f(locs.uTime, performance.now() / 1000.0);
        }

        if (locs.uIsUnderwater) {
            const cam = this.engine.scene.mainView?.object ?? this.engine.scene.activeViews[0]?.object;
            if (cam) {
                cam.getPositionWorld(this._tempVec);
                gl.uniform1f(locs.uIsUnderwater, this._tempVec[1] < -0.5 ? 1.0 : 0.0);
            }
        }

        if (locs.uHeightmapTexture && planet && planet.heightmapTexture) {
            gl.uniform1i(locs.uHeightmapTexture, PostInjector.HEIGHTMAP_TEX_UNIT);
        }

        if (locs.uHeightmapCenter && planet) {
            gl.uniform2f(locs.uHeightmapCenter, planet.heightmapCenterX, planet.heightmapCenterZ);
        }

        if (locs.uHeightmapSize && planet) {
            gl.uniform1f(locs.uHeightmapSize, planet.heightmapWorldSize);
        }

        if (locs.uWorldOriginOffset) {
            if (planet) {
                gl.uniform2f(
                    locs.uWorldOriginOffset,
                    planet.logicalHeightmapCenterX - planet.heightmapCenterX,
                    planet.logicalHeightmapCenterZ - planet.heightmapCenterZ,
                );
            } else {
                gl.uniform2f(locs.uWorldOriginOffset, 0.0, 0.0);
            }
        }

        if (locs.uGridWrapSize) {
            gl.uniform1f(
                locs.uGridWrapSize,
                grass?.wrapSize ?? PostInjector.DEFAULT_GRASS_WRAP_SIZE,
            );
        }

        if (locs.uPlayerPosition) {
            const cam = this.engine.scene.activeViews[0]?.object ?? this.engine.scene.mainView?.object;
            if (cam) {
                cam.getPositionWorld(this._tempVec);
                gl.uniform3f(locs.uPlayerPosition, this._tempVec[0], this._tempVec[1], this._tempVec[2]);
            }
        }
    }
}
