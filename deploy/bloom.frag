#version 300 es
#line 1 1

#line 1
/*
 * Set of functions you can reuse to work on colors.
 */

/**
 * Create a gradient between four colors
 *
 * @param stop0 The color of the first stop point
 * @param stop1 The color of the second stop point
 * @param stop2 The color of the third stop point
 * @param stop3 The color of the fourth stop point
 *
 * This method assumes the stops are linear and spaced uniformly.
 */
mediump vec4 gradient4(mediump vec4 stop0, mediump vec4 stop1, mediump vec4 stop2, mediump vec4 stop3, highp float value) {
    highp float value2 = value * 2.0;
    mediump vec4 a = mix(stop0, stop1, value2);
    mediump vec4 b = mix(stop2, stop3, value2 - 1.0);
    return mix(a, b, smoothstep(0.495, 0.505, value));
}

/**
 * Apply the sRGB transfer function to a linear RGB color
 *
 * @param linear Linear RGB color
 * @returns Non-linear sRGB color
 *
 * Uses a 2.2 gamma curve as a fast approximation for the sRGB EOTF. Alpha is
 * unaffected.
 */
lowp vec4 linearToSrgb(mediump vec4 linear) {
    return vec4(pow(linear.rgb, vec3(1.0/2.2)), linear.a);
}

/** @overload */
lowp vec3 linearToSrgb(mediump vec3 linear) {
    return pow(linear, vec3(1.0/2.2));
}

/**
 * Apply the inverse sRGB transfer function to get a linear RGB color
 *
 * @param srgb Non-linear sRGB color
 * @returns Linear RGB color
 *
 * Uses a 2.2 gamma curve as a fast approximation for the sRGB EOTF. Alpha is
 * unaffected.
 */
mediump vec4 srgbToLinear(mediump vec4 srgb) {
    /* Input is mediump to avoid precision issues in pow() */
    return vec4(pow(srgb.rgb, vec3(2.2)), srgb.a);
}

/** @overload */
mediump vec3 srgbToLinear(mediump vec3 srgb) {
    return pow(srgb, vec3(2.2));
}


/**
 * ACES Tonemapping, luminance-only approximation
 * https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
 */
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
#line 4



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

mediump vec4 tap(mediump vec2 offset) {
    mediump vec4 color = textureLod(bloomTexture, textureCoordinates + offset, lod);
    if((flags & (1u << 0u)) != 0u) {
        /**
         * @todo We should apply srgbToLinear on color, but this causes a lot of
         * (temporal) instability
         */
        mediump float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        /* Avoid NaN propagating through the entire pyramid */
        if(luminance < threshold || isnan(luminance))
            color.rgb = vec3(0.0);
    }
    return color;
}

void main() {
    if((flags & (1u << 1u)) != 0u) {
        /* Downsample to half the resolution. Extra filtering here (as opposed
         * to a single bilinear texture sample) avoids aliasing. */
        outColor =
            0.5*tap(vec2(0.0)) +
            0.125*
            (tap(-spacing) +
            tap(vec2( spacing.x, -spacing.y)) +
            tap(vec2(-spacing.x,  spacing.y)) +
            tap(spacing));
    } else {
        /* Upsample to previous higher resolution. Filtering here produces a
         * blur approaching a Gaussian with a circle-like shape. */
        outColor =
            (1.0/6.0)*
            (tap(-spacing) +
                tap(vec2( spacing.x, -spacing.y)) +
                tap(vec2(-spacing.x,  spacing.y)) +
                tap(spacing)) +
            (1.0/12.0)*
            (tap(vec2(0.0,  2.0*spacing.y)) +
                tap(vec2(0.0, -2.0*spacing.y)) +
                tap(vec2( 2.0*spacing.x, 0.0)) +
                tap(vec2(-2.0*spacing.x, 0.0)));
        /* Result is blended with the old buffer of the resolution we're
         * upsampling to. Fixed-function blending so we can reuse the render
         * texture. */
        outColor.a = width;
    }

    if((flags & (1u << 3u)) != 0u) {
        mediump vec3 hdrColor = srgbToLinear(texture(sceneTexture, textureCoordinates).rgb);
        /* Additive blending */
        mediump vec3 color = hdrColor + bloomIntensity*outColor.rgb;
        /* Tonemapping */
        outColor.rgb = linearToSrgb(tonemap(color*exposure));
        /** @todo Support transparency */
        outColor.a = 1.0;
    }
}