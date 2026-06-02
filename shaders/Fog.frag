#include "lib/Compatibility.frag"

#define USE_LIGHTS
#define FEATURE_TEXTURED
#define FEATURE_ALPHA_MASKED
#define FEATURE_VERTEX_COLORS
#define FEATURE_TONEMAPPING
#define FEATURE_WITH_FOG
#define FEATURE_LOOKAT

#define USE_MATERIAL_ID
#if NUM_LIGHTS > 0
#define USE_POSITION_WORLD
#endif
#ifdef LOOKAT
#define USE_POSITION_VIEW
#endif

#ifdef TEXTURED
#define USE_TEXTURE_COORDS
#endif
#ifdef VERTEX_COLORS
#define USE_COLOR
#endif

#include "lib/Uniforms.glsl"
#include "lib/Inputs.frag"
#include "lib/Color.glsl"

#if NUM_LIGHTS > 0 || defined(WITH_FOG)
#include "lib/Quaternion.glsl"
#include "lib/Lights.frag"
#endif

#ifdef TEXTURED
#include "lib/Textures.glsl"
#endif
#include "lib/Packing.glsl"
#include "lib/Materials.glsl"

struct Material {
    lowp vec4 color;
#ifdef TEXTURED
    mediump uint flatTexture;
#endif
};

/* --- Noise --- */

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

Material decodeMaterial(uint matIndex) {
    {{decoder}}
    return mat;
}

void main() {
#ifdef TEXTURED
    alphaMask(fragMaterialId, fragTextureCoords);
#endif

    Material mat = decodeMaterial(fragMaterialId);

    /* Sample the gradient texture */
    lowp vec4 texColor = vec4(1.0);
    #ifdef TEXTURED
    texColor = textureAtlas(mat.flatTexture, fragTextureCoords);
    #endif

    lowp vec4 baseColor =
        #ifdef VERTEX_COLORS
        fragColor *
        #endif
        texColor * mat.color;

    /* Texture alpha encodes vertical gradient: 1 at bottom, 0 at top */
    float h = 1.0 - texColor.a;

    /* Bottom half: solid fog. Top half: fade out. */
    float fadeStart = 0.4;
    float topFade = clamp((h - fadeStart) / (1.0 - fadeStart), 0.0, 1.0);
    float baseAlpha = 1.0 - topFade * topFade;

    /* Animated noise in the top fade zone */
    highp float time = 0.0;
    #if NUM_LIGHTS > 0
    time = lightPositionsWorld[1].x;
    #endif

    /* Convert cylinder surface to a flat 2D sheet:
       arc length (angle * radius) x height, both in world units
       so noise cells are square → round fog blobs, not stripes. */
    highp float radius = length(fragPositionWorld.xz);
    highp float arc = atan(fragPositionWorld.z, fragPositionWorld.x) * radius;
    highp float cy = fragPositionWorld.y;

    /* Both axes in same world-unit scale, low frequency = big soft blobs */
    highp float scale = 0.04;
    highp vec2 fogUV1 = vec2(arc, cy) * scale + vec2(time * 0.12, time * 0.05);
    highp vec2 fogUV2 = vec2(arc + 17.3, cy + 31.7) * scale * 1.7 + vec2(-time * 0.08, time * 0.1);

    highp float n1 = valueNoise(fogUV1);
    highp float n2 = valueNoise(fogUV2);
    highp float noise = n1 * 0.6 + n2 * 0.4;

    /* Noise only affects the fade zone (top half) */
    float fogAlpha = baseAlpha * mix(1.0, mix(0.3, 1.0, noise), topFade);
    fogAlpha = clamp(fogAlpha, 0.0, 1.0);

    outColor = vec4(baseColor.rgb, baseColor.a * fogAlpha);

    #ifdef TONEMAPPING
    #ifndef WITH_FOG
    vec3 linear = srgbToLinear(outColor.rgb);
    linear *= cameraParams.y;
    outColor.rgb = linearToSrgb(tonemap(linear));
    #endif
    #endif
}
