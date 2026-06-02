#include "lib/Compatibility.frag"

#define USE_LIGHTS
#define FEATURE_WITH_FOG
#define FEATURE_SHADOW_PCF
#define FEATURE_TEXTURED 
#define FEATURE_FADE
#define TEXTURED 
#define USE_MATERIAL_ID
#if NUM_LIGHTS > 0
#define USE_POSITION_WORLD
#endif
#if NUM_SHADOWS > 0
#define USE_POSITION_VIEW
#endif

// Textures support
#ifdef TEXTURED
#define USE_TEXTURE_COORDS
#endif

#include "lib/Uniforms.glsl"
#include "lib/Inputs.frag"
#include "lib/Math.glsl"

#if NUM_LIGHTS > 0 || defined(WITH_FOG)
#include "lib/Quaternion.glsl"
#include "lib/Lights.frag"
#endif

// Essential libs for TextureAtlas and Materials
#include "lib/Packing.glsl"
#include "lib/Materials.glsl"

#ifdef TEXTURED
#include "lib/Textures.glsl"
#endif

// Define Material Struct
struct Material {
    #ifdef WITH_FOG
    lowp vec4 fogColor;
    #endif
    #ifdef TEXTURED
    mediump uint diffuseTexture;
    mediump uint skyboxTexture; 
    #endif
    highp float scroll;      // 0 to 1 (High precision for smooth scroll)
    highp float tilingScale; // User variable for scale
};

Material decodeMaterial(uint matIndex) {
    {{decoder}}
    return mat;
}

// Gradient Noise (Smoother than Value Noise)
highp vec2 hash2(highp vec2 p) {
    p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
    return -1.0 + 2.0*fract(sin(p)*43758.5453123);
}

highp float noise(highp vec2 p) {
    highp vec2 i = floor(p);
    highp vec2 f = fract(p);
    highp vec2 u = f*f*(3.0-2.0*f);
    
    return mix(mix(dot(hash2(i + vec2(0.0,0.0)), f - vec2(0.0,0.0)),
                   dot(hash2(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x),
               mix(dot(hash2(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)),
                   dot(hash2(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x), u.y);
}

void main() {
    Material mat = decodeMaterial(fragMaterialId);

    // User defined origin for water transparency fade
    #ifdef FADE
    const vec3 FADE_ORIGIN = vec3(0.0, -0.0, -0.0);
    const float FADE_RADIUS = 600.0; // Radius where it starts to fade
    const float FADE_WIDTH = 200.0;  // Transition width (increased for smoothness)
    #endif

    const vec3 WATER_DEEP = vec3(0.0, 0.8, 0.8); 
    const vec3 WATER_SHALLOW = vec3(0.4, 0.8, 0.9); 

    // Use light position X as time source for continuous non-loopy flow
    highp float time = 0.0;
    #if NUM_LIGHTS > 0
    time = lightPositionsWorld[1].x;
    #endif

    // Linear continuous movement
    // Adjust multipliers to control speed and direction
    highp vec2 scrollOffset1 = vec2(time * 0.1, time * 0.2); 
    highp vec2 scrollOffset2 = vec2(time * -0.15, time * 0.25); 

    // Animated Noise Waves with Tiling Variable
    highp float waveScale = (mat.tilingScale > 0.001) ? mat.tilingScale : 0.1; 
    highp vec2 waveUV = fragPositionWorld.xz * waveScale;
    
    // Noise Generation (Gradient Noise + FBM-ish layering)
    // 0.5 + 0.5 * noise to remap -1..1 to 0..1
    highp float n1 = 0.5 + 0.5 * noise(waveUV + scrollOffset1);
    highp float n2 = 0.5 + 0.5 * noise(waveUV * 2.0 - scrollOffset2);
    float wavePattern = n1 * 0.6 + n2 * 0.4;

    // Tighter banding keeps the surface readable while still feeling animated.
    float crest = smoothstep(0.44, 0.62, wavePattern);
    float waterMix = clamp(wavePattern * 0.25 + crest * 0.75, 0.0, 1.0);

    // Base Albedo
    vec3 albedo = mix(WATER_DEEP, WATER_SHALLOW, waterMix);
    
    // Sample Diffuse (Distorted)
    vec2 swayUV = fragTextureCoords + vec2(scrollOffset1.x, scrollOffset1.y) * 0.05;
    vec4 texColor = textureAtlas(mat.diffuseTexture, swayUV);
    
    albedo *= mix(texColor.rgb, texColor.rgb * vec3(0.85, 0.92, 0.98), 0.35);

    // Reflection: keep it cheap by reusing the existing wave samples to build
    // a smoother, glossier normal instead of adding more lookups.
    vec3 viewDir = normalize(fragPositionWorld - viewPositionWorld);
    vec2 waveSlope =
        vec2(n1 - 0.5, n2 - 0.5) * 0.18 +
        vec2(wavePattern - 0.5, crest - 0.5) * 0.10;
    vec3 normal = normalize(vec3(waveSlope.x, 1.45, waveSlope.y)); 
    
    vec3 reflectDir = reflect(viewDir, normal);
    
    vec2 skyUV = vec2(atan(reflectDir.z, reflectDir.x), asin(reflectDir.y));
    skyUV *= vec2(0.1591, 0.3183); 
    skyUV += 0.5;
    
    vec4 reflectionColor = textureAtlas(mat.skyboxTexture, skyUV);
    
    float ndotv = clamp(dot(normal, -viewDir), 0.0, 1.0);
    float invNdotV = 1.0 - ndotv;
    float invNdotV2 = invNdotV * invNdotV;
    float fresnel = 0.08 + 0.92 * invNdotV2 * invNdotV2 * invNdotV;
    float reflectionStrength = clamp(fresnel * 1.15 + crest * 0.10, 0.0, 1.0);

    vec3 waterBody = albedo * vec3(0.76, 0.88, 0.96);
    albedo = mix(waterBody, reflectionColor.rgb, reflectionStrength);

    vec3 color = vec3(0.0);

    // Ambient
    const float BRIGHTNESS = 1.2;
    color += albedo * BRIGHTNESS;

    #ifdef WITH_FOG
    #ifdef REVERSE_Z
    float dist = (1.0 - gl_FragCoord.z)/gl_FragCoord.w;
    #else
    float dist = gl_FragCoord.z/gl_FragCoord.w;
    #endif
    float fogFactor = fogBlendFactor(dist, mat.fogColor.a*0.2);
    color = mix(color, mat.fogColor.rgb, fogFactor);
    #endif

    // Distance Fade Logic
    #ifdef FADE
    const float ALPHA_NEAR = 0.2; // Transparency within radius
    const float ALPHA_FAR = 0.0;  // Transparency outside radius

    float distFromOrigin = distance(fragPositionWorld, FADE_ORIGIN);
    float fadeFactor = smoothstep(FADE_RADIUS, FADE_RADIUS + FADE_WIDTH, distFromOrigin);
    float finalAlpha = mix(ALPHA_NEAR, ALPHA_FAR, fadeFactor);

    // Discard only when practically invisible to avoid jagged edges
    if (finalAlpha < 0.001) discard;

    // Apply fade to base alpha AND color (premultiplied alpha assumption)
    outColor = vec4(color * finalAlpha, finalAlpha);
    #else
    float finalAlpha = 0.8; // Default transparency
    outColor = vec4(color * finalAlpha, finalAlpha);
    #endif
}
