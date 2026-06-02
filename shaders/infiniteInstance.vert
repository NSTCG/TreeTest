
/** this is essesntial for runtime to detect the shader*/
/** wind.vert */


#ifdef WEBGL
#ifdef MULTIDRAW
#extension GL_ANGLE_multi_draw : require
#endif
#endif


precision highp float;

#define LOOK_AT_PLAYER 1
#define MATCH_GROUND_NORMAL 1

/* Normal and tangent are float16, but we transform them with highp quats
 * anyway so do the conversion as early as possible */
layout(location = 0) in highp vec3 inPosition;
#ifdef TEXTURE_COORDS
layout(location = 1) in highp vec2 inTextureCoords;
#endif
#ifdef COLOR
layout(location = 2) in mediump vec4 inColor;  // Vertex color, with red channel determining heightFactor
#endif
#ifdef TANGENT
layout(location = 3) in highp vec4 inTangent;
#endif
#ifndef MULTIDRAW
layout(location = 4) in mediump uint inObjectId;
#endif
#ifdef NORMAL
layout(location = 5) in highp vec3 inNormal;
#endif

#ifdef TEXTURE_COORDS_1
layout(location = 10) in highp vec2 inTextureCoords1;
#endif

#include "lib/Quaternion.glsl"

#ifdef POSITION_WORLD
out highp vec3 fragPositionWorld;
#endif
#ifdef POSITION_VIEW
out highp vec3 fragPositionView;
#endif
#ifdef TEXTURE_COORDS
out highp vec2 fragTextureCoords;
#endif
#ifdef TEXTURE_COORDS_1
out highp vec2 fragTextureCoords1;
#endif

#ifdef COLOR
out mediump vec4 fragColor;
#endif

#ifdef TANGENT
out mediump vec4 fragTangent;
#endif
#ifdef OBJECT_ID
flat out mediump uint fragObjectId;
#endif
#ifdef MATERIAL_ID
flat out mediump uint fragMaterialId;
#endif
#ifdef NORMAL
out mediump vec3 fragNormal;
#endif
#ifdef BARYCENTRIC
out mediump vec3 fragBarycentric;
#endif

#include "lib/Uniforms.glsl"

// Uniforms for lights and time
uniform Lights {
    highp vec3 lightPositionsWorld[NUM_LIGHTS];
    highp vec3 lightDirectionsWorld[NUM_LIGHTS];
    mediump vec4 lightColors[NUM_LIGHTS];
    highp vec4 lightParameters[NUM_LIGHTS];
};


// Define default fallback values as constants.
// const float DEFAULT_LARGE_WIND_AMPLITUDE   = 0.2;
// const float DEFAULT_LARGE_WIND_FREQUENCY   = 0.05;
// const float DEFAULT_LARGE_WIND_SPEED       = 0.3;

// const float DEFAULT_SMALL_WIND_AMPLITUDE   = 0.1;
// const float DEFAULT_SMALL_WIND_FREQUENCY   = 0.5;
// const float DEFAULT_SMALL_WIND_SPEED       = 1.5;

// const float DEFAULT_GRASS_JITTER_AMPLITUDE = 0.05;
// const float DEFAULT_GRASS_JITTER_FREQUENCY = 1.0;
// const float DEFAULT_GRASS_JITTER_SPEED     = 2.0;


const float DEFAULT_LARGE_WIND_AMPLITUDE   = 0.75;
const float DEFAULT_LARGE_WIND_FREQUENCY   = 0.05;
const float DEFAULT_LARGE_WIND_SPEED       = 0.45;

const float DEFAULT_SMALL_WIND_AMPLITUDE   = 1.15;
const float DEFAULT_SMALL_WIND_FREQUENCY   = 0.5;
const float DEFAULT_SMALL_WIND_SPEED       = 1.9;

const float DEFAULT_GRASS_JITTER_AMPLITUDE = 0.12;
const float DEFAULT_GRASS_JITTER_FREQUENCY = 1.0;
const float DEFAULT_GRASS_JITTER_SPEED     = 2.6;

const float DEFAULT_TIME_SCALE = 1.0;




// Declare the uniforms that can be optionally provided.
uniform float u_largeWindAmplitude;
uniform float u_largeWindFrequency;
uniform float u_largeWindSpeed;

uniform float u_smallWindAmplitude;
uniform float u_smallWindFrequency;
uniform float u_smallWindSpeed;

uniform float u_grassJitterAmplitude;
uniform float u_grassJitterFrequency;
uniform float u_grassJitterSpeed;


uniform float u_time;
uniform float u_timeScale;

uniform sampler2D u_noiseTexture; 



// Helper functions to return either the uniform value or the default fallback.
float getLargeWindAmplitude() {
    return (u_largeWindAmplitude == 0.0) ? DEFAULT_LARGE_WIND_AMPLITUDE : u_largeWindAmplitude;
}
float getLargeWindFrequency() {
    return (u_largeWindFrequency == 0.0) ? DEFAULT_LARGE_WIND_FREQUENCY : u_largeWindFrequency;
}
float getLargeWindSpeed() {
    return (u_largeWindSpeed == 0.0) ? DEFAULT_LARGE_WIND_SPEED : u_largeWindSpeed;
}

float getSmallWindAmplitude() {
    return (u_smallWindAmplitude == 0.0) ? DEFAULT_SMALL_WIND_AMPLITUDE : u_smallWindAmplitude;
}
float getSmallWindFrequency() {
    return (u_smallWindFrequency == 0.0) ? DEFAULT_SMALL_WIND_FREQUENCY : u_smallWindFrequency;
}
float getSmallWindSpeed() {
    return (u_smallWindSpeed == 0.0) ? DEFAULT_SMALL_WIND_SPEED : u_smallWindSpeed;
}

float getGrassJitterAmplitude() {
    return (u_grassJitterAmplitude == 0.0) ? DEFAULT_GRASS_JITTER_AMPLITUDE : u_grassJitterAmplitude;
}
float getGrassJitterFrequency() {
    return (u_grassJitterFrequency == 0.0) ? DEFAULT_GRASS_JITTER_FREQUENCY : u_grassJitterFrequency;
}
float getGrassJitterSpeed() {
    return (u_grassJitterSpeed == 0.0) ? DEFAULT_GRASS_JITTER_SPEED : u_grassJitterSpeed;
}

float getTimeScale(){
    return (u_timeScale == 0.0) ? DEFAULT_TIME_SCALE : u_timeScale;
}

float getTime(){
    //there is 2 ways to pass time , either move the first light in runtime in x direction with dt on update 
    // or pass u_time as a uniform by intercepting the gl context at runtime
#if NUM_LIGHTS > 1
    float fallbackTime = lightPositionsWorld[1][0];
#else
    float fallbackTime = 0.0;
#endif
    return (u_time == 0.0) ? fallbackTime * getTimeScale() : u_time * getTimeScale();
}


// --- Add this helper function at the top if it's not already defined ---
float rand(float seed) {
    return fract(sin(seed) * 43758.5453123);
}

// --- Perlin Noise function ---
// A simple 2D noise function built on the rand() helper.
float perlinNoise(vec2 st) {
    vec2 i = floor(st);
    vec2 f = fract(st);
    
    // Four corners in 2D
    float a = rand(dot(i, vec2(12.9898, 78.233)));
    float b = rand(dot(i + vec2(1.0, 0.0), vec2(12.9898, 78.233)));
    float c = rand(dot(i + vec2(0.0, 1.0), vec2(12.9898, 78.233)));
    float d = rand(dot(i + vec2(1.0, 1.0), vec2(12.9898, 78.233)));
    
    // Smooth interpolation
    vec2 u = f * f * (3.0 - 2.0 * f);
    
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

vec2 cheapWindWave(vec2 worldPos, float frequency, float speed, float time, float seed) {
    vec2 scaled = worldPos * (frequency * 6.2831853);
    float phaseA = dot(scaled, vec2(0.73, 0.41) + seed * vec2(0.013, 0.007)) + time * speed;
    float phaseB = dot(scaled, vec2(-0.37, 0.91) - seed * vec2(0.005, 0.009)) + time * speed * 1.23;
    return vec2(sin(phaseA), cos(phaseB));
}


// --- Scattering Functions ---

// Uniform scattering in a circle (polar coordinates).
vec2 scatterUniform(uint objId, float scatterRadius) {
    float seed = float(objId);
    float angle = 2.0 * 3.14159265 * rand(seed);
    float r = scatterRadius * sqrt(rand(seed + 1.0));
    return vec2(cos(angle), sin(angle)) * r;
}

// Noise-based scattering example.
// Here we sample a noise texture (u_noiseTexture) using coordinates derived from the object id.
vec2 scatterNoise(uint objId, float scatterRadius) {
    // Create a coordinate based on the id.
    float x = mod(float(objId), 10.0) / 10.0;
    float y = float(objId) / 10.0 / 10.0;
    float noiseVal = texture(u_noiseTexture, vec2(x, y)).r; // Use the red channel
    // Map the noise value to an angle.
    float angle = noiseVal * 2.0 * 3.14159265;
    // Here we could also use noise to vary the radius.
    float r = scatterRadius; // For a simple example, use a constant radius.
    return vec2(cos(angle), sin(angle)) * r;
}

// Grid-based scattering: place each object at the center of a grid cell.
vec2 scatterGrid(uint objId, float cellSize) {
    int cellsPerRow = 10; // Example value—adjust as needed.
    int cellX = int(objId) % cellsPerRow;
    int cellY = int(objId) / cellsPerRow;
    return vec2(cellX, cellY) * cellSize;
}

// Main scattering dispatcher.
// 'mode' selects the algorithm: 0 = uniform, 1 = noise-based, 2 = grid.
vec2 computeScatter(uint objId, float scatterRadius, float cellSize, int mode) {
    if(mode == 0) {
        return scatterUniform(objId, scatterRadius);
    } else if(mode == 1) {
        return scatterNoise(objId, scatterRadius);
    } else if(mode == 2) {
        return scatterGrid(objId, cellSize);
    }
    return vec2(0.0); // Fallback
}



// --- Helper functions for noise computation ---
    float random(in vec2 st) {
        return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    float noise(in vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) +
               (c - a) * u.y * (1.0 - u.x) +
               (d - b) * u.x * u.y;
    }

    float fbm(in vec2 st) {
        float value = 0.0;
        float amplitude = 0.5;
        // You can adjust the number of iterations for more detail
        for (int i = 0; i < 5; i++) {
            value += amplitude * noise(st);
            st *= 2.0;
            amplitude *= 0.5;
        }
        return value;
    }

    uniform vec2 u_heightmapCenter;
    uniform float u_heightmapSize;
    uniform vec3 u_playerPosition;
    uniform float u_gridWrapSize;
    uniform vec2 u_worldOriginOffset;

    // --- Heightmap texture from Planet (CPU-generated, precision-perfect) ---
    uniform highp sampler2D u_heightmapTexture;
    #define u_heightMap u_heightmapTexture // Compatibility define for logic below if needed

    // Toggle this to 1 to use pure GPU noise, 0 to use the Heightmap texture
    #define USE_GPU_NOISE 0

    #if USE_GPU_NOISE
    
    // --- Terrain procedural height logic matching planet.ts ---
    float hashTerrain(vec2 p) {
        vec2 st = vec2(50.0 * fract(p.x * 0.3183099 + 0.71),
                       50.0 * fract(p.y * 0.3183099 + 0.113));
        return -1.0 + 2.0 * fract(st.x * st.y * (st.x + st.y));
    }

    float valueNoiseTerrain(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float v00 = hashTerrain(i);
        float v10 = hashTerrain(i + vec2(1.0, 0.0));
        float v01 = hashTerrain(i + vec2(0.0, 1.0));
        float v11 = hashTerrain(i + vec2(1.0, 1.0));
        return v00 + u.x * (v10 - v00) + u.y * (v01 - v00) + u.x * u.y * (v00 - v10 - v01 + v11);
    }

    float getTerrainHeight(vec2 worldPos) {
        float h = 0.0;
        vec2 p = worldPos * 0.02;
        float amp = 15.0; // u_terrainAmplitude fallback
        for (int i = 0; i < 4; i++) {
            h += valueNoiseTerrain(p) * amp;
            p *= 2.0;
            amp *= 0.5;
        }
        return h;
    }

    #else
    
    float getTerrainHeight(vec2 worldPos) {
        if (u_heightmapSize <= 0.0) {
            return 0.0;
        }

        // Convert world XZ to heightmap UV [0,1]
        vec2 uv = (worldPos - u_heightmapCenter) / u_heightmapSize + vec2(0.5);

        // Outside the live terrain tile should stay flat.
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
            return 0.0;
        }

        // Match the working example: plain texture sampling from the vertex shader.
        return texture(u_heightmapTexture, uv).r;
    }

    #endif

    vec3 getTerrainNormalFast(vec2 worldPos, float centerHeight) {
    #if USE_GPU_NOISE
        float sampleStep = 1.0;
    #else
        float sampleStep = max(u_heightmapSize / 256.0, 0.35);
    #endif
        float hL = getTerrainHeight(worldPos - vec2(sampleStep, 0.0));
        float hR = getTerrainHeight(worldPos + vec2(sampleStep, 0.0));
        float hD = getTerrainHeight(worldPos - vec2(0.0, sampleStep));
        float hU = getTerrainHeight(worldPos + vec2(0.0, sampleStep));

        vec3 terrainNormal = vec3(hL - hR, sampleStep * 2.0, hD - hU);
        return normalize(terrainNormal);
    }

void main() {


    /* Temporaries since we have no out variables */
    #ifndef POSITION_WORLD
    highp vec3 fragPositionWorld;
    #endif
    #ifndef POSITION_VIEW
    highp vec3 fragPositionView;
    #endif
    #ifndef OBJECT_ID
    mediump uint fragObjectId;
    #endif

    
  


   

    #ifdef MULTIDRAW
    fragObjectId = uint(gl_DrawID); /* idOffset not needed! */
    #else
    fragObjectId = inObjectId;
    #endif

    /* Match the engine's instanced path: each instance advances the transform lookup. */
    fragObjectId += uint(gl_InstanceID);

    ivec2 idx = 2*ivec2((int(fragObjectId)) & OBJECTS_PER_ROW_MASK, int(fragObjectId >> OBJECTS_PER_ROW_LOG2));
    highp vec4 transform[2] = vec4[](
        texelFetchOffset(transformations, idx, 0, ivec2(0, 0)),
        texelFetchOffset(transformations, idx, 0, ivec2(1, 0)));
    highp vec4 scaling =
        texelFetchOffset(transformations, idx, 0, ivec2(0, 1));
    #ifdef MATERIAL_ID
    fragMaterialId = uint(scaling.w);
    #endif

    /* Transformed vertex position */
    fragPositionWorld = quat2_transformPoint(Quat2(transform[0], transform[1]), scaling.xyz*inPosition);
    fragPositionView = quat2_transformPoint(Quat2(worldToView[0], worldToView[1]), fragPositionWorld);

    /* Transformed normal vector */
    #ifdef NORMAL
    fragNormal = normalize(quat_transformVector(transform[0], scaling.xyz*inNormal));
    #endif

    #ifdef TANGENT
    fragTangent = vec4(normalize(quat_transformVector(transform[0], scaling.xyz*inTangent.xyz)), inTangent.w);
    #endif


          /**CUSTOM CODE START*/

    // === Runtime-provided config ===
    // PostInjector feeds these every frame so the wrapped grass tile stays aligned
    // with the live heightmap tile generated in planet.ts.

    vec2 playerPos = u_playerPosition.xz;

    // Compute object/world origin (block center) from per-instance transform.
    // Quat2 transform is already available as `transform[0], transform[1]`.
    // Transform the local origin (0,0,0) to get the block center in world space.
    highp vec3 blockCenterWorld = quat2_transformPoint(Quat2(transform[0], transform[1]), vec3(0.0));

    // Wrap parameters
    float wrapSize = ( (u_gridWrapSize == 0.0) ? 200.0 : u_gridWrapSize );
    // If you want different wrap in X and Z, change to a vec2 uniform; kept scalar for simplicity.

    // Compute wrapped position for block center around player
    // result is a new center (wrappedCenter) near the player within +/- wrapSize/2
    vec2 offsetToPlayer = blockCenterWorld.xz - playerPos;
    vec2 wrappedOffset = mod(offsetToPlayer + 0.5 * wrapSize, wrapSize) - 0.5 * wrapSize;
    vec2 wrappedCenter = playerPos + wrappedOffset;

    // Delta to apply to every vertex in this instance (move whole block)
    vec2 blockDelta = wrappedCenter - blockCenterWorld.xz;

    // Apply delta to the computed fragPositionWorld (which already includes object transform + vertex)
    fragPositionWorld.x += blockDelta.x;
    fragPositionWorld.z += blockDelta.y;

     /* --- ADD HEIGHT FADE NEAR WRAP EDGES --- */
    // Uniforms (add these to your material / set from JS)
    // uniform float u_fadeInner; // distance (meters) where full height remains
    // uniform float u_fadeOuter; // distance (meters) where height is fully 0

    float renderDistance = wrapSize * 0.5;
    float fadeOuter = renderDistance;
    float fadeInner = max(0.0, fadeOuter - 10.0);

    // Safety: ensure a valid range for division to prevent NaN slabs
    if (fadeInner >= fadeOuter) {
        fadeInner = max(0.0, fadeOuter - 10.0);
    }

    // Distance from player to wrapped block center
    vec2 toPlayer = wrappedCenter - playerPos;
    float distSqToPlayer = dot(toPlayer, toPlayer);
    float renderDistanceSq = renderDistance * renderDistance;

    // Cull whole grass blocks once they are outside the requested render distance.
    if (distSqToPlayer >= renderDistanceSq) {
        gl_Position = vec4(uintBitsToFloat(0x7fc00000u));
        return;
    }

    float distToPlayer = sqrt(distSqToPlayer);

    // fade = 1.0 inside fadeInner, 0.0 outside fadeOuter
    // Safety: epsilon prevents division-by-zero if fadeInner == fadeOuter
    float fadeFactor = 1.0 - smoothstep(fadeInner, fadeOuter + 0.0001, distToPlayer);
    fadeFactor = clamp(fadeFactor, 0.0, 1.0);

    // Recompute vertex local position relative to block center
    vec3 vertexLocal = fragPositionWorld - vec3(wrappedCenter.x, blockCenterWorld.y, wrappedCenter.y);

    vec2 bladeRootWorld = fragPositionWorld.xz;

    #ifdef TEXTURE_COORDS
    bladeRootWorld = wrappedCenter + inTextureCoords;
    #endif

    float time = getTime();
    vec2 windDir = normalize(vec2(0.9284767, 0.3713907));
    vec2 crossWindDir = vec2(-windDir.y, windDir.x);
    vec2 bladeBaseXZ = bladeRootWorld;
    vec2 logicalBladeBaseXZ = bladeBaseXZ + u_worldOriginOffset;
    float largeWindFrequency = max(getLargeWindFrequency(), 0.001);
    float smallWindFrequency = max(getSmallWindFrequency(), 0.001);
    vec2 largeNoiseUv = logicalBladeBaseXZ * (largeWindFrequency * 0.72) + windDir * (time * getLargeWindSpeed() * 0.24);
    vec2 detailNoiseUv = logicalBladeBaseXZ * (smallWindFrequency * 1.45) + crossWindDir * (time * getSmallWindSpeed() * 0.34);
    float flowNoise = fbm(largeNoiseUv + vec2(7.13, 19.71));
    float crossNoise = fbm(detailNoiseUv + vec2(-11.37, 5.23));
    float gustNoise = fbm(largeNoiseUv * 0.55 + detailNoiseUv * 0.2 + vec2(2.41, 9.17));
    float alongWind = flowNoise * 2.0 - 1.0;
    alongWind = sign(alongWind) * alongWind * alongWind;
    float sideWind = (crossNoise * 2.0 - 1.0) * 0.95;
    float gustStrength = 0.95 + smoothstep(0.35, 0.9, gustNoise) * 1.65;
    vec2 restLean = windDir * (getLargeWindAmplitude() * 0.42);
    vec2 dynamicWind = (
        windDir * (alongWind * getLargeWindAmplitude() * 1.45 * gustStrength) +
        crossWindDir * (sideWind * getSmallWindAmplitude() * 1.15)
    );

    #if LOOK_AT_PLAYER
    int bladeVertexId = gl_VertexID % 3;
    float bladeSide = 0.0;
    bool isBaseVertex = false;
    if (bladeVertexId == 0) {
        bladeSide = -1.0;
        isBaseVertex = true;
    } else if (bladeVertexId == 1) {
        bladeSide = 1.0;
        isBaseVertex = true;
    }

    vec2 baseOffset = fragPositionWorld.xz - bladeRootWorld;
    float halfWidth = isBaseVertex ? max(length(baseOffset), 0.0001) : 0.0;

    vec2 toCameraXZ = playerPos - bladeRootWorld;
    float toCameraLenSq = max(dot(toCameraXZ, toCameraXZ), 1e-4);
    vec2 cameraRight = vec2(toCameraXZ.y, -toCameraXZ.x) * inversesqrt(toCameraLenSq);

    if (isBaseVertex) {
        fragPositionWorld.xz = bladeRootWorld + cameraRight * (bladeSide * halfWidth);
    } else {
        fragPositionWorld.xz = bladeRootWorld;
    }

    vertexLocal = fragPositionWorld - vec3(wrappedCenter.x, blockCenterWorld.y, wrappedCenter.y);
    #endif

    // --- Per-Vertex Height Sampling ---
    float tHeight = getTerrainHeight(bladeRootWorld);
    
    // ABSOLUTE GROUNDING: We set the height directly instead of +=.
    // This anchors the grass base to the terrain surface (tHeight) 
    // while keeping its local blade shape (vertexLocal.y).
    float grassRootOffset = -0.02;
    fragPositionWorld.y = tHeight + (vertexLocal.y + grassRootOffset) * fadeFactor;

    #ifdef NORMAL
    #if MATCH_GROUND_NORMAL
    /* Pure up-normal for grass — eliminates horizon color bleed caused by
       view-angle-dependent PBR lighting with a tilted normal. */
    fragNormal = vec3(0.0, 1.0, 0.0);
    #endif
    #endif
    
    /* --- END HEIGHT FADE --- */

    // --- Wind effect: scrolling noise field with a spring-back response ---
    float bladeHeight = 3.1;
    float windInfluence = smoothstep(0.0, bladeHeight, max(vertexLocal.y, 0.0));
    
    #ifdef COLOR
    windInfluence *= mix(0.9, 1.75, clamp(inColor.g, 0.0, 1.0));
    #endif
    windInfluence = min(windInfluence * 2.1, 2.6);

    float springNoise = fbm(detailNoiseUv * 0.85 + vec2(float(fragObjectId) * 0.011, 4.7));
    float springPhase = time * (getGrassJitterSpeed() * 1.5) + springNoise * 6.2831853;
    float springStrength = 0.1 + 0.16 * (0.5 + 0.5 * sin(springPhase));
    vec2 springOffset = -dynamicWind * springStrength;
    vec2 combinedWindOffset = (restLean + dynamicWind + springOffset) * windInfluence;
    float bendMagnitude = length(combinedWindOffset);
    fragPositionWorld.x += combinedWindOffset.x;
    fragPositionWorld.z += combinedWindOffset.y;
    fragPositionWorld.y += bendMagnitude * (0.13 + 0.08 * springStrength) * windInfluence;

    /**CUSTOM CODE END*/


    
    // Transform position to view coordinates
    fragPositionView = quat2_transformPoint(Quat2(worldToView[0], worldToView[1]), fragPositionWorld);

    #ifdef PARABOLOID
    highp float dist = -fragPositionView.z;
    // Calculate and set the X and Y coordinates
    gl_Position.xyz = normalize(fragPositionView.xyz);
    gl_Position.xy /= 1.0 - gl_Position.z;
    // Calculate and set the Z and W coordinates
    gl_Position.z = (dist - cameraParams.z) / (cameraParams.w - cameraParams.z);
    gl_Position.z = gl_Position.z * 2.0 - 1.0;
    gl_Position.w = 1.0;
    #else
    /* Transform the position */
    gl_Position = projectionMatrix*vec4(fragPositionView, 1.0f);

    #ifdef TEXTURE_COORDS
    /* Texture coordinates, if needed */
    fragTextureCoords = inTextureCoords;
    #endif

    #ifdef TEXTURE_COORDS_1
    fragTextureCoords1 = inTextureCoords1;
    #endif

    #ifdef COLOR
    fragColor = inColor;
    #endif


    #ifdef BARYCENTRIC
    /* Barycentric without dynamic indexed vector, which is emulated on WebGL */
    fragBarycentric[0] = float(gl_VertexID % 3 == 0)*1.0;
    fragBarycentric[1] = float(gl_VertexID % 3 == 1)*1.0;
    fragBarycentric[2] = float(gl_VertexID % 3 == 2)*1.0;
    #endif
}
