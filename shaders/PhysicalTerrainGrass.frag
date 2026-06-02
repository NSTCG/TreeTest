#include "lib/Compatibility.glsl"

#define USE_LIGHTS

#define FEATURE_TEXTURED
#define FEATURE_ALPHA_MASKED
#define FEATURE_VERTEX_COLORS
#define FEATURE_NORMAL_MAPPING
#define FEATURE_WITH_EMISSIVE
#define FEATURE_LIGHTMAP
#define FEATURE_LIGHTMAP_MULTIPLY_ALBEDO
#define FEATURE_OCCLUSION_TEXTURE
#define FEATURE_SEPARATE_OCCLUSION_TEXTURE
#define FEATURE_GLOBAL_ILLUMINATION
#define FEATURE_CLEARCOAT
#define FEATURE_GLOBAL_ILLUMINATION_PROBE_VOLUME
#define FEATURE_SSAO
#define FEATURE_TONEMAPPING
#define FEATURE_SHADOW_PCF
#define FEATURE_SHADOW_NORMAL_OFFSET_SCALE_BY_SHADOW_DEPTH
#define FEATURE_SHADOW_NORMAL_OFFSET_UV_ONLY
#define FEATURE_SHADOW_NORMAL_OFFSET_SLOPE_SCALE
#define FEATURE_WITH_FOG
#define FEATURE_WATER_INTERACTION

#ifdef NORMAL_MAPPING
#define TEXTURED
#endif
#ifdef LIGHTMAP
#define TEXTURED
#endif
#ifdef OCCLUSION_TEXTURE
#define TEXTURED
#endif
#ifdef GLOBAL_ILLUMINATION
#define TEXTURED
#endif

#define USE_POSITION_WORLD
#define USE_NORMAL
#define USE_MATERIAL_ID
#ifdef TEXTURED
#define USE_TEXTURE_COORDS
#endif
#ifdef NORMAL_MAPPING
#define USE_TANGENT
#endif
#ifdef LIGHTMAP
#define USE_TEXTURE_COORDS_1
#endif
#ifdef VERTEX_COLORS
#define USE_COLOR
#endif

#if NUM_SHADOWS > 0
#define USE_POSITION_VIEW
#endif

#include "lib/Uniforms.glsl"
#include "lib/Inputs.glsl"
#include "lib/Math.glsl"
#include "lib/Color.glsl"

#if NUM_LIGHTS > 0 || defined(WITH_FOG)
#include "lib/Quaternion.glsl"
#endif
#include "lib/Lights.glsl"

#ifdef TEXTURED
#include "lib/Textures.glsl"
#endif
#include "lib/Surface.glsl"
#include "lib/Packing.glsl"
#include "lib/Materials.glsl"

#include "lib/PhysicalBSDF.glsl"

#if defined(GLOBAL_ILLUMINATION) || defined(GLOBAL_ILLUMINATION_PROBE_VOLUME)
#include "lib/CoordinateSystems.glsl"
#include "lib/GI.glsl"
#endif

struct Material {
    lowp vec4 albedoColor;
#ifdef WITH_EMISSIVE
    lowp vec4 emissiveColor;
#endif
#ifdef WITH_FOG
    lowp vec4 fogColor;
#endif
    lowp float metallicFactor;
    lowp float roughnessFactor;
#ifdef TEXTURED
    mediump uint albedoTexture;
#ifndef SEPARATE_OCCLUSION_TEXTURE
    mediump uint occlusionRoughnessMetallicTexture;
#else
    mediump uint roughnessMetallicTexture;
#endif
#ifdef WITH_EMISSIVE
    mediump uint emissiveTexture;
#endif
#ifdef NORMAL_MAPPING
    mediump uint normalTexture;
#endif
#ifdef LIGHTMAP
    mediump uint lightmapTexture;
    lowp float lightmapFactor;
#endif
#ifdef OCCLUSION_TEXTURE
#ifdef SEPARATE_OCCLUSION_TEXTURE
    mediump uint occlusionTexture;
#endif
    lowp float occlusionFactor;
#endif
#endif
#ifdef CLEARCOAT
    lowp float clearCoatRoughness;
    lowp float clearCoatFactor;
#endif
};

uniform highp vec2 u_worldOriginOffset;

highp float hash12(highp vec2 p) {
    p = mod(p, 1024.0);
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

highp float valueNoise(highp vec2 p) {
    highp vec2 i = floor(p);
    highp vec2 f = fract(p);
    highp vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(mix(hash12(i + vec2(0.0, 0.0)),
                   hash12(i + vec2(1.0, 0.0)), u.x),
               mix(hash12(i + vec2(0.0, 1.0)),
                   hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

/* ── Terrain color palette — identical to Physical.frag ── */
const lowp vec3 TERRAIN_SHADE_COLOR = vec3(0.40, 0.48, 0.19);
const lowp vec3 TERRAIN_BASE_COLOR  = vec3(0.64, 0.77, 0.30);
const lowp vec3 TERRAIN_LIGHT_COLOR = vec3(0.87, 0.94, 0.57);
const lowp vec3 TERRAIN_WIND_COLOR  = vec3(0.94, 0.98, 0.74);

/* Defined dark green for grass blade tips */
const lowp vec3 GRASS_TIP_COLOR = vec3(0.18, 0.35, 0.10);

highp float terrainTime() {
    #if NUM_LIGHTS > 1
    return lightPositionsWorld[1].x;
    #else
    return 0.0;
    #endif
}

/* Terrain color — identical logic to Physical.frag sharedTerrainColor */
lowp vec3 sharedTerrainColor(highp vec3 worldPos) {
    highp float tiling = 0.085;
    highp float windStrength = 0.35;
    highp float time = terrainTime();

    highp vec2 uv = worldPos.xz * tiling;
    highp vec2 windScroll = vec2(0.16, -0.07) * time * (0.55 * windStrength);
    highp float macroNoise  = valueNoise(uv * 0.55 + vec2(7.3, 19.1));
    highp float detailNoise = valueNoise(uv * 1.65 + vec2(31.7, 91.3));
    highp float movingNoise = valueNoise(uv * 1.15 + windScroll);
    highp float ribbon = 0.5 + 0.5 * sin(
        (uv.x * 0.9 + uv.y * 0.45) * 6.2831853 +
        detailNoise * 1.6 +
        time * 1.25 * windStrength
    );
    highp float ribbonMask = smoothstep(0.52, 0.88, ribbon * 0.7 + movingNoise * 0.3);
    highp float heightBlend = clamp((worldPos.y + 6.0) * 0.045, 0.0, 1.0);

    /* slope is always 0 because we use normal = (0,1,0) for grass */

    lowp vec3 baseColor = mix(
        TERRAIN_SHADE_COLOR,
        TERRAIN_BASE_COLOR,
        clamp(0.28 + macroNoise * 0.58 + heightBlend * 0.10, 0.0, 1.0)
    );
    lowp vec3 ground = mix(
        baseColor,
        TERRAIN_LIGHT_COLOR,
        clamp((heightBlend - 0.16) * 1.2 + detailNoise * 0.22, 0.0, 1.0)
    );
    /* no slope darkening for grass (slope = 0) */
    ground = mix(
        ground,
        TERRAIN_WIND_COLOR,
        ribbonMask * windStrength * 0.22
    );
    ground *= 0.92 + detailNoise * 0.12;

    return clamp(ground, 0.0, 1.0);
}

/* 0.0 at blade base, 1.0 at blade tip — driven by vertex color */
float grassTipBlend() {
#ifdef VERTEX_COLORS
    return clamp(max(fragColor.r, max(fragColor.g, fragColor.b)) * 1.6, 0.0, 1.0);
#else
    return 1.0;
#endif
}

Material decodeMaterial(uint matIndex) {
    {{decoder}}
    return mat;
}

void main() {
    #ifdef TEXTURED
    alphaMask(fragMaterialId, fragTextureCoords);
    #endif

    Material mat = decodeMaterial(fragMaterialId);

    lowp vec4 albedo = mat.albedoColor;

    #ifdef TEXTURED
    if(mat.albedoTexture > 0u) {
        albedo *= textureAtlas(mat.albedoTexture, fragTextureCoords);
    }
    #endif
    albedo = srgbToLinear(albedo);

    lowp float ao = 1.0;
    float roughness = mat.roughnessFactor;
    float metallic = mat.metallicFactor;
    #ifdef TEXTURED
    #ifndef SEPARATE_OCCLUSION_TEXTURE
    if(mat.occlusionRoughnessMetallicTexture > 0u) {
        lowp vec3 orm = textureAtlas(mat.occlusionRoughnessMetallicTexture, fragTextureCoords).rgb;
        #ifdef OCCLUSION_TEXTURE
        ao = mix(1.0, orm.r, mat.occlusionFactor);
        #endif
        roughness *= orm.g;
        metallic *= orm.b;
    }
    #else
    if(mat.roughnessMetallicTexture > 0u) {
        lowp vec3 rm = textureAtlas(mat.roughnessMetallicTexture, fragTextureCoords).rgb;
        roughness *= rm.g;
        metallic *= rm.b;
    }
    #ifdef OCCLUSION_TEXTURE
    if(mat.occlusionTexture > 0u) {
        float occlusion = textureAtlas(mat.occlusionTexture, fragTextureCoords).r;
        ao = mix(1.0, occlusion, mat.occlusionFactor);
    }
    #endif
    #endif
    #endif

    #ifdef SSAO
    vec2 screenUV = (gl_FragCoord.xy - vec2(viewport.xy))/vec2(viewport.zw);
    ao *= texture(ambientOcclusion, screenUV).r;
    #endif

    #ifdef NORMAL_MAPPING
    SurfaceData surface = computeSurfaceData(fragNormal, fragTangent);
    mediump vec3 normal = normalMapping(surface, mat.normalTexture, fragTextureCoords);
    #else
    SurfaceData surface = computeSurfaceData(fragNormal);
    mediump vec3 normal = surface.normal;
    #endif

    highp vec3 logicalWorldPos = fragPositionWorld;
    logicalWorldPos.xz += u_worldOriginOffset;

    vec3 view = normalize(viewPositionWorld - fragPositionWorld);

    /* Force normal straight up — this is the key fix for the horizon color
       bleed. PBR environment lighting samples differently based on view vs
       normal angle; a tilted normal causes the lit color to shift when the
       camera tilts, creating a visible horizon line across all blades.
       With normal locked to (0,1,0), diffuse lighting is view-independent. */
    normal = vec3(0.0, 1.0, 0.0);

    /* Per-blade gradient: terrain color at base → dark green at tip */
    #ifdef VERTEX_COLORS
    float tipT = grassTipBlend();
    albedo.rgb = mix(sharedTerrainColor(logicalWorldPos), GRASS_TIP_COLOR, tipT);
    #endif

    #ifdef CLEARCOAT
    ClearCoatData clearCoat = createClearCoatData(surface.normal, mat.clearCoatFactor, mat.clearCoatRoughness);
    PhysicalBSDF bsdf = createPhysicalBSDF(albedo.rgb, metallic, roughness, mat.clearCoatFactor);
    #else
    PhysicalBSDF bsdf = createPhysicalBSDF(albedo.rgb, metallic, roughness, 0.0);
    #endif

    vec3 col = vec3(0.0);

    #ifdef TEXTURED
    #ifdef LIGHTMAP
    lowp vec4 lightmap =
        textureAtlas(mat.lightmapTexture, fragTextureCoords1)*mat.lightmapFactor;
    #ifndef LIGHTMAP_MULTIPLY_ALBEDO
    col += lightmap.rgb;
    #else
    col += lightmap.rgb*albedo.rgb;
    #endif
    #endif
    #endif

    #ifdef GLOBAL_ILLUMINATION
    #ifdef CLEARCOAT
    col += evaluateEnvironmentClearCoat(normal, view, bsdf.diffuse, bsdf.perceptualRoughness, bsdf.specular, ao, clearCoat);
    #else
    col += evaluateEnvironment(normal, view, bsdf.diffuse, bsdf.perceptualRoughness, bsdf.specular, ao);
    #endif
    #endif

    #ifdef GLOBAL_ILLUMINATION_PROBE_VOLUME
    col += evaluateProbeVolume(fragPositionWorld, normal, bsdf.diffuse);
    #endif

    col += evaluateDirectLights(bsdf, view, normal);

    #ifdef WITH_EMISSIVE
    vec4 emissive = mat.emissiveColor;
    #ifdef TEXTURED
    if(mat.emissiveTexture != 0u) {
        emissive *= textureAtlas(mat.emissiveTexture, fragTextureCoords);
    }
    #endif
    col += emissive.a*srgbToLinear(emissive.rgb);
    #endif

    #ifdef WATER_INTERACTION
    const float WATER_LEVEL_BASE = -0.0;
    const float VISIBILITY_DEPTH = 2.5;

    const vec3 WATER_SHALLOW = vec3(0.25, 0.70, 0.85);
    const vec3 WATER_MID     = vec3(0.10, 0.40, 0.75);
    const vec3 WATER_DEEP    = vec3(0.01, 0.10, 0.35);

    highp float yDist = fragPositionWorld.y - WATER_LEVEL_BASE;
    const highp float MAX_FOAM_REACH = 2.2;

    float rawDepth = max(-yDist / VISIBILITY_DEPTH, 0.0);

    vec3 waterTint = mix(
        mix(WATER_SHALLOW, WATER_MID, clamp(rawDepth * 2.0, 0.0, 1.0)),
        WATER_DEEP,
        clamp((rawDepth - 0.5) * 2.0, 0.0, 1.0)
    );
    if (rawDepth > 1.0) {
        waterTint = mix(waterTint, vec3(0.00, 0.01, 0.05), clamp((rawDepth - 1.0) * 0.5, 0.0, 1.0));
    }

    if (yDist <= -VISIBILITY_DEPTH) {
        col = waterTint;
    } else {
        if (yDist < 0.0) {
            float depth = clamp(rawDepth, 0.0, 1.0);
            col = mix(col, waterTint, depth);
        }

        if (abs(yDist) < MAX_FOAM_REACH) {
            highp float time = 0.0;
            #if NUM_LIGHTS > 0
            time = lightPositionsWorld[1].x;
            #endif

            highp vec2 scrollOffset = vec2(time * 0.1, time * 0.2);
            highp float waveScale = 0.1;
            highp vec2 waveUV = fragPositionWorld.xz * waveScale;
            highp float wavePattern = valueNoise(waveUV + scrollOffset);

            highp float waveHeight = (wavePattern - 0.5) * 2.0;
            highp float foamCenterY = WATER_LEVEL_BASE + waveHeight;

            highp float foamThickness = 1.2;
            highp float distToWave = abs(fragPositionWorld.y - foamCenterY);

            if (distToWave < foamThickness) {
                 highp float foamFactor = smoothstep(foamThickness, 0.0, distToWave);
                 col = mix(col, vec3(1.0), foamFactor * 0.8);
            }
        }
    }
    #endif

    

    // #ifdef WITH_FOG
   // #ifdef REVERSE_Z
    //float fogDist = (1.0 - gl_FragCoord.z)/gl_FragCoord.w;
    //#else
   // float fogDist = gl_FragCoord.z/gl_FragCoord.w;
    //#endif
    //float fogFactor = fogBlendFactor(fogDist, mat.fogColor.a*0.2);
    //#endif



    #ifdef WITH_FOG
    #ifdef REVERSE_Z
    float dist = (1.0 - gl_FragCoord.z)/gl_FragCoord.w;
    #else
    float dist = gl_FragCoord.z/gl_FragCoord.w;
    #endif
    
    // Exponential fog with start and end distances
    float fogStart = 25.0;  // Distance where fog starts
    float fogEnd =30.0;  // Distance where fog reaches maximum
    float fogDensity = mat.fogColor.a * 0.05;  // Fog density factor
    
    float adjustedDist = max(0.0, dist - fogStart);
    float fogFactor = 1.0 - exp(-fogDensity * adjustedDist);
    fogFactor = clamp(fogFactor * (dist / fogEnd), 0.0, 1.0);
    
    #endif

    #ifdef TONEMAPPING
    col *= cameraParams.y;
    col = tonemap(col);
    #endif

    outColor = linearToSrgb(vec4(col, albedo.a));

    #ifdef WITH_FOG
    outColor.rgb = mix(outColor.rgb, mat.fogColor.rgb, fogFactor);
    #endif
}
