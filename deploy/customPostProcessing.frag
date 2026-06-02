#version 300 es

/* 
 * Custom Post Processing Shader
 * Replaces the default Bloom shader.
 */

uniform BloomUniforms {
    lowp uint flags;
    mediump float lod;
    mediump vec2 spacing;
    mediump float threshold;
    mediump float width;
    mediump float bloomIntensity;
    mediump float exposure;
};

uniform mediump sampler2D bloomTexture;
uniform mediump sampler2D sceneTexture;

in mediump vec2 textureCoordinates;

out mediump vec4 outColor;

mediump vec4 srgbToLinear(mediump vec4 srgb) {
    return vec4(pow(srgb.rgb, vec3(2.2)), srgb.a);
}

lowp vec4 linearToSrgb(mediump vec4 linear) {
    return vec4(pow(linear.rgb, vec3(1.0/2.2)), linear.a);
}

lowp vec3 tonemapACESFittedApproximation(mediump vec3 color) {
    const mediump float a = 2.51*(0.6*0.6);
    const mediump float b = 0.03*0.6;
    const mediump float c = 2.43*(0.6*0.6);
    const mediump float d = 0.59*0.6;
    const mediump float e = 0.14;
    return clamp((color*(a*color + b))/(color*(c*color + d) + e), 0.0, 1.0);
}

lowp vec3 tonemap(mediump vec3 color) {
    return tonemapACESFittedApproximation(color);
}

void main() {
    outColor.r *= 10.0;
    outColor.g *=10.0;
    outColor.b *=10.0;
    outColor.a = 1.0;
}
