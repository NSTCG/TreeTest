#include "lib/Compatibility.glsl"

#define FEATURE_TEXTURED
#define FEATURE_ALPHA_MASKED
#define FEATURE_VERTEX_COLORS
#define FEATURE_TONEMAPPING
#define FEATURE_WITH_FOG
#define FEATURE_LOOKAT

#ifdef TEXTURED
#define USE_TEXTURE_COORDS
#endif
#ifdef VERTEX_COLORS
#define USE_COLOR
#endif
#ifdef LOOKAT
#define USE_LOOKAT
#endif

#define USE_MATERIAL_ID
#include "lib/Uniforms.glsl"
#include "lib/Inputs.glsl"
#include "lib/Color.glsl"

#ifdef TEXTURED
#include "lib/Textures.glsl"
#endif
#include "lib/Packing.glsl"
#include "lib/Materials.glsl"

struct Material {
    lowp vec4 color;
#ifdef WITH_FOG
    lowp vec4 fogColor;
#endif
#ifdef TEXTURED
    mediump uint flatTexture;
#endif
};

Material decodeMaterial(uint matIndex) {
    {{decoder}}
    return mat;
}

void main() {
#ifdef TEXTURED
    alphaMask(fragMaterialId, fragTextureCoords);
#endif

    Material mat = decodeMaterial(fragMaterialId);
    outColor =
        #ifdef VERTEX_COLORS
        fragColor*
        #endif
        #ifdef TEXTURED
        textureAtlas(mat.flatTexture, fragTextureCoords)*
        #endif
        mat.color;

    #ifdef TONEMAPPING
    vec3 linear = srgbToLinear(outColor.rgb);
    /* Apply exposure */
    linear *= cameraParams.y;
    outColor.rgb = linearToSrgb(tonemap(linear));
    #endif

    #ifdef WITH_FOG
    #ifdef REVERSE_Z
    float dist = (1.0 - gl_FragCoord.z)/gl_FragCoord.w;
    #else
    float dist = gl_FragCoord.z/gl_FragCoord.w;
    #endif
    
    // Exponential fog with start and end distances
    float fogStart = 25.0;  // Distance where fog starts
    float fogEnd = 30.0;    // Distance where fog reaches maximum
    float fogDensity = mat.fogColor.a * 0.05;  // Fog density factor
    
    float adjustedDist = max(0.0, dist - fogStart);
    float fogFactor = 1.0 - exp(-fogDensity * adjustedDist);
    fogFactor = clamp(fogFactor * (dist / fogEnd), 0.0, 1.0);
    
    outColor.rgb = mix(outColor.rgb, mat.fogColor.rgb, fogFactor);
    #endif
}
