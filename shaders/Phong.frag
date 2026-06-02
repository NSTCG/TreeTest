#include "lib/Compatibility.glsl"

#define USE_LIGHTS

#define FEATURE_WITH_FOG
#define FEATURE_WATER_INTERACTION // Enable this to turn on water foam/submersion
#define FEATURE_LIGHTNING_FOG     // Lightning flash + volumetric fog enhancement
#define FEATURE_WITH_SPECULAR
#define FEATURE_TEXTURED
#define FEATURE_ALPHA_MASKED
#define FEATURE_NORMAL_MAPPING
#define FEATURE_VERTEX_COLORS
#define FEATURE_WITH_EMISSIVE
#define FEATURE_LIGHTMAP
#define FEATURE_LIGHTMAP_MULTIPLY_DIFFUSE
#define FEATURE_GLOBAL_ILLUMINATION
#define FEATURE_GLOBAL_ILLUMINATION_PROBE_VOLUME
#define FEATURE_TONEMAPPING
#define FEATURE_SHADOW_PCF
#define FEATURE_SHADOW_NORMAL_OFFSET_SCALE_BY_SHADOW_DEPTH
#define FEATURE_SHADOW_NORMAL_OFFSET_UV_ONLY
#define FEATURE_SHADOW_NORMAL_OFFSET_SLOPE_SCALE
#define FEATURE_DEPRECATED_AMBIENT_FACTOR
#define FEATURE_DEPRECATED_LIGHT_ATTENUATION

#ifdef NORMAL_MAPPING
#define TEXTURED
#endif

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

#if NUM_LIGHTS > 0
#define USE_POSITION_WORLD
#endif

#if NUM_SHADOWS > 0
#define USE_POSITION_VIEW
#endif

#include "lib/Uniforms.glsl"
#include "lib/Inputs.glsl"
#include "lib/Math.glsl"

#if NUM_LIGHTS > 0 || defined(WITH_FOG)
#include "lib/Quaternion.glsl"
#include "lib/Lights.glsl"
#endif

#ifdef TEXTURED
#include "lib/Textures.glsl"
#endif
#include "lib/Surface.glsl"
#include "lib/Packing.glsl"
#include "lib/Materials.glsl"

#if defined(GLOBAL_ILLUMINATION) || defined(GLOBAL_ILLUMINATION_PROBE_VOLUME)
#include "lib/CoordinateSystems.glsl"
#include "lib/GI.glsl"
#endif

#ifdef TONEMAPPING
#include "lib/Color.glsl"
#endif

struct Material {
    lowp vec4 ambientColor;
    lowp vec4 diffuseColor;
#ifdef WITH_SPECULAR
    lowp vec4 specularColor;
#endif
#ifdef WITH_EMISSIVE
    lowp vec4 emissiveColor;
#endif

#ifdef WITH_FOG
    lowp vec4 fogColor;
#endif

#ifdef TEXTURED
    mediump uint diffuseTexture;
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
#endif

#ifdef WITH_SPECULAR
    lowp uint shininess;
#endif

#ifdef DEPRECATED_AMBIENT_FACTOR
    lowp float ambientFactor;
#endif
};

Material decodeMaterial(uint matIndex) {
    {{decoder}}
    return mat;
}

mediump float phongDiffuseBrdf(mediump vec3 lightDir, mediump vec3 normal) {
    return max(0.0, dot(lightDir, normal));
}

mediump float phongSpecularBrdf(mediump vec3 lightDir, mediump vec3 normal, mediump vec3 viewDir, mediump float shininess) {
    mediump vec3 reflection = reflect(lightDir, normal);
    return pow(max(dot(viewDir, reflection), 0.0), shininess);
}

/* Wrap the hash domain so the sin() inputs stay bounded on large world coordinates. */
highp float hash12(highp vec2 p) {
    p = mod(p, 1024.0);
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/* Single-octave value noise is the cheaper option; wrapping the hash keeps it stable on mobile. */
highp float valueNoise(highp vec2 p) {
    highp vec2 i = floor(p);
    highp vec2 f = fract(p);
    highp vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(mix(hash12(i + vec2(0.0, 0.0)),
                   hash12(i + vec2(1.0, 0.0)), u.x),
               mix(hash12(i + vec2(0.0, 1.0)),
                   hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() { 
    #ifdef TEXTURED
    alphaMask(fragMaterialId, fragTextureCoords); 
    #endif

    Material mat = decodeMaterial(fragMaterialId);

    lowp vec4 finalDiffuseColor =
        #ifdef VERTEX_COLORS
    fragColor *
        #endif
        mat.diffuseColor;

    #ifdef TEXTURED
    if(mat.diffuseTexture > 0u) {
        finalDiffuseColor *= textureAtlas(mat.diffuseTexture, fragTextureCoords);
    }
    #endif

    #ifdef DEPRECATED_AMBIENT_FACTOR
    lowp vec4 finalAmbientColor = mat.ambientColor + finalDiffuseColor * mat.ambientFactor;
    #else
    lowp vec4 finalAmbientColor = mat.ambientColor * finalDiffuseColor;
    #endif

    #ifdef WITH_SPECULAR
    lowp vec4 finalSpecularColor = mat.specularColor;
    finalSpecularColor.rgb *= finalSpecularColor.a;
    #endif

    #ifdef TEXTURED
    #ifdef LIGHTMAP
    lowp vec4 lightmap = textureAtlas(mat.lightmapTexture, fragTextureCoords1) * mat.lightmapFactor;
    #ifndef LIGHTMAP_MULTIPLY_DIFFUSE
    finalAmbientColor.rgb += lightmap.rgb;
    #else
    finalAmbientColor.rgb += lightmap.rgb * finalDiffuseColor.rgb;
    #endif
    #endif
    #endif

    /* Ambient color */
    outColor = vec4(finalAmbientColor.rgb, finalDiffuseColor.a);

    #if NUM_LIGHTS > 0
    mediump vec3 ambLight = lightColors[numPointLights + numSpotLights].rgb * lightColors[numPointLights + numSpotLights].a;
    outColor.rgb *= ambLight;
    #endif

    #ifdef WITH_SPECULAR
    mediump float shininess = float(mat.shininess);
    #endif

    /* Normal */
    #ifdef NORMAL_MAPPING
    SurfaceData surface = computeSurfaceData(fragNormal, fragTangent);
    mediump vec3 normal = normalMapping(surface, mat.normalTexture);
    #else
    SurfaceData surface = computeSurfaceData(fragNormal);
    mediump vec3 normal = surface.normal;
    #endif

    #ifdef GLOBAL_ILLUMINATION
    vec3 irradiance = evaluateEnvironmentIrradiance(normal);
    /* cheap linear-to-srgb conversion */
    outColor.rgb += finalDiffuseColor.rgb * sqrt(irradiance);
    #endif

    #ifdef GLOBAL_ILLUMINATION_PROBE_VOLUME
    vec3 volumeIrradiance = evaluateProbeVolume(fragPositionWorld, normal);
    outColor.rgb += finalDiffuseColor.rgb * sqrt(volumeIrradiance * RECIPROCAL_PI);
    #endif

    #if NUM_LIGHTS > 0
    /* Normally the view vector points to the viewer, but we can save ourselves
     * some negations this way. By passing the standard outward light vector to
     * reflect() (which expects an incident vector), these two cancel out. */
    mediump vec3 viewDir = normalize(fragPositionWorld - viewPositionWorld);

    #ifdef WITH_SPECULAR
    bool useSpecular = finalSpecularColor.a != 0.0 && shininess != 0.0;
    #endif

    for(lowp uint i = 0u; i < pointLightCount; ++i) {
        mediump vec4 lightData = lightColors[i];
        /* dot product of mediump vec3 can be NaN for distances > 128 */
        highp vec3 lightPos = lightPositionsWorld[i];
        highp vec3 lightDirAccurate = lightPos - fragPositionWorld;
        mediump float distSq = dot(lightDirAccurate, lightDirAccurate);
        mediump float attenuation = distanceAttenuation(distSq, lightData.a);

        if(attenuation < 0.001)
            continue;

        mediump vec3 lightDir = lightDirAccurate;
        lightDir *= inversesqrt(distSq);

        /* Add diffuse color */
        mediump vec3 value = finalDiffuseColor.rgb * phongDiffuseBrdf(lightDir, normal);

        #ifdef WITH_SPECULAR
        /* Add specular color */
        if(useSpecular) {
            value += finalSpecularColor.rgb *
                phongSpecularBrdf(lightDir, normal, viewDir, shininess);
        }
        #endif

        float shadow = 1.0;
        #if NUM_SHADOWS > 0
        /* Shadows */
        bool shadowsEnabled = bool(lightParameters[i].z);
        if(shadowsEnabled) {
            int shadowIndex = int(lightParameters[i].w) + int(dot(lightDir, lightDirectionsWorld[i]) < 0.0);
            shadow = sampleShadowParaboloid(shadowIndex);
        }
        #endif
        outColor.rgb += shadow * attenuation * value * lightData.rgb;
    }

    lowp uint startSpotLights = pointLightCount + 1u;
    lowp uint endSpotLights = pointLightCount + spotLightCount;
    for(lowp uint i = startSpotLights; i < endSpotLights; ++i) {
        mediump vec4 lightData = lightColors[i];
        /* dot product of mediump vec3 can be NaN for distances > 128 */
        highp vec3 lightPos = lightPositionsWorld[i];
        highp vec3 lightDirAccurate = lightPos - fragPositionWorld;
        mediump float distSq = dot(lightDirAccurate, lightDirAccurate);
        mediump float attenuation = distanceAttenuation(distSq, lightData.a);

        if(attenuation < 0.001)
            continue;

        mediump vec3 lightDir = lightDirAccurate;
        lightDir *= inversesqrt(distSq);

        highp vec3 spotDir = lightDirectionsWorld[i];
        attenuation *= spotAttenuation(lightDir, spotDir, lightParameters[i].x, lightParameters[i].y);

        if(attenuation < 0.001)
            continue;

        /* Add diffuse color */
        mediump vec3 value = finalDiffuseColor.rgb * phongDiffuseBrdf(lightDir, normal);

        #ifdef WITH_SPECULAR 
        /* Add specular color */
        if(useSpecular) {
            value += finalSpecularColor.rgb *
                phongSpecularBrdf(lightDir, normal, viewDir, shininess);
        }
        #endif

        float shadow = 1.0;
        #if NUM_SHADOWS > 0
        /* Shadows */
        bool shadowsEnabled = bool(lightParameters[i].z);
        if(shadowsEnabled) {
            int shadowIndex = int(lightParameters[i].w);
            shadow = sampleShadowPerspective(shadowIndex, surface.normal, lightDir);
        }
        #endif
        outColor.rgb += shadow * attenuation * value * lightData.rgb;
    }

    // Skip ambient and fog sun 
    lowp uint startSunLights = pointLightCount + spotLightCount + 1u;
    lowp uint endSunLights = uint(max(int(startSunLights), int(pointLightCount + spotLightCount + sunLightCount) - 2));
    for(lowp uint i = startSunLights; i < endSunLights; ++i) {
        mediump vec4 lightData = lightColors[i];
        mediump vec3 lightDir = lightDirectionsWorld[i]; 

        /* Add diffuse color */
        mediump vec3 value = finalDiffuseColor.rgb *
            phongDiffuseBrdf(lightDir, normal);

        #ifdef WITH_SPECULAR
        /* Add specular color */
        if(useSpecular) {
            value += finalSpecularColor.rgb *
                phongSpecularBrdf(lightDir, normal, viewDir, shininess);
        }
        #endif

        float shadow = 1.0;
        #if NUM_SHADOWS > 0
        /* Shadows */
        bool shadowsEnabled = bool(lightParameters[i].z);
        if(shadowsEnabled) {
            int shadowIndex = int(lightParameters[i].w);
            float depth = -fragPositionView.z;
            int cascade = selectCascade(shadowIndex, depth);
            if(cascade != -1)
                shadow = sampleShadowOrtho(shadowIndex + cascade, surface.normal, lightDir);
        }
        #endif
        outColor.rgb += shadow * lightData.a * value * lightData.rgb;
    }

    #endif

    #ifdef WITH_EMISSIVE
    vec4 emissive = mat.emissiveColor;
    #ifdef TEXTURED
    if(mat.emissiveTexture != 0u) {
        emissive *= textureAtlas(mat.emissiveTexture, fragTextureCoords);
    }
    #endif
    outColor.rgb += emissive.a * emissive.rgb;
    #endif

    /* ===== LIGHTNING FLASH ===== */
    #ifdef LIGHTNING_FOG
    #if NUM_LIGHTS > 0
    {
        mediump float lTime = lightPositionsWorld[0].x;
        /* Pseudo-random flash trigger — cheap hash of quantized time */
        mediump float flashSeed = fract(sin(floor(lTime * 0.7) * 12.9898) * 43758.5453);
        mediump float flashOn = step(0.92, flashSeed); /* ~8% of time slots flash */
        /* Sub-frame flicker within the flash window */
        mediump float flashPhase = fract(lTime * 3.5);
        mediump float flashBrightness = flashOn * smoothstep(1.0, 0.0, flashPhase);
        /* Top-down directional bias using surface normal */
        mediump float directional = max(0.0, normal.y) * 0.7 + 0.3;
        /* Additive flash: cool white-blue, modulated by direction */
        outColor.rgb += vec3(0.7, 0.75, 0.95) * flashBrightness * directional * 1.5;
    }
    #endif
    #endif

    /* ===== FOG ===== */
    #ifdef WITH_FOG
    #ifdef REVERSE_Z
    mediump float fogDist = (1.0 - gl_FragCoord.z) / gl_FragCoord.w;
    #else
    mediump float fogDist = gl_FragCoord.z / gl_FragCoord.w;
    #endif
    mediump float fogFactor = fogBlendFactor(fogDist, mat.fogColor.a*0.2);
    #endif

    #ifdef WATER_INTERACTION
    // SUBMERSION EFFECT & FOAM
    const float WATER_LEVEL_BASE = -0.0; 
    const float VISIBILITY_DEPTH = 2.5; 
    const vec3 UNDERWATER_TINT = vec3(0.1906497, 0.4913783, 0.6313725);

    /* Keep the cheap early-outs, but only evaluate wave noise close to the foam band. */
    highp float yDist = fragPositionWorld.y - WATER_LEVEL_BASE;
    const highp float MAX_FOAM_REACH = 2.2;
    if (yDist <= -VISIBILITY_DEPTH) {
        outColor.rgb = UNDERWATER_TINT;
    } else {
        // 1. SUBMERSION (Flat Surface Line)
        if (yDist < 0.0) {
            float depth = clamp(-yDist / VISIBILITY_DEPTH, 0.0, 1.0);
            outColor.rgb = mix(outColor.rgb, UNDERWATER_TINT, depth);
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

            // 2. FOAM (Wavy, Offset Mirrored Top/Bottom)
            highp float foamThickness = 1.2;
            highp float distToWave = abs(fragPositionWorld.y - foamCenterY);
        
            if (distToWave < foamThickness) {
                 highp float foamFactor = smoothstep(foamThickness, 0.0, distToWave);
                 outColor.rgb = mix(outColor.rgb, vec3(1.0), foamFactor * 0.8);
            }
        }
    }
    #endif

    #ifdef TONEMAPPING
    outColor.rgb = tonemap(outColor.rgb);
    #endif

    #ifdef WITH_FOG
    outColor.rgb = mix(outColor.rgb, mat.fogColor.rgb, fogFactor);
    #endif
}
