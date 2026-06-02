#ifdef WEBGL
#ifdef MULTIDRAW
#extension GL_ANGLE_multi_draw : require
#endif
#endif

precision highp float;

layout(location = 0) in highp vec3 inPosition;
#ifdef TEXTURE_COORDS
layout(location = 1) in highp vec2 inTextureCoords;
#endif
#ifdef COLOR
layout(location = 2) in mediump vec4 inColor;
#endif
#ifndef MULTIDRAW
layout(location = 4) in mediump uint inObjectId;
#endif

#ifdef POSITION_WORLD
out highp vec3 fragPositionWorld;
#endif
#ifdef POSITION_VIEW
out highp vec3 fragPositionView;
#endif
#ifdef TEXTURE_COORDS
out highp vec2 fragTextureCoords;
#endif
#ifdef COLOR
out mediump vec4 fragColor;
#endif
#ifdef OBJECT_ID
flat out mediump uint fragObjectId;
#endif
#ifdef MATERIAL_ID
flat out mediump uint fragMaterialId;
#endif

#include "lib/Uniforms.glsl"
#include "lib/Quaternion.glsl"

void main() {
    #ifdef MULTIDRAW
    mediump uint objId = uint(gl_DrawID);
    #else
    mediump uint objId = inObjectId;
    #endif

    objId += uint(gl_InstanceID);

    #ifdef OBJECT_ID
    fragObjectId = objId;
    #endif

    ivec2 idx = 2 * ivec2(int(objId) & OBJECTS_PER_ROW_MASK, int(objId >> OBJECTS_PER_ROW_LOG2));
    highp vec4 transform[2] = vec4[](
        texelFetchOffset(transformations, idx, 0, ivec2(0, 0)),
        texelFetchOffset(transformations, idx, 0, ivec2(1, 0))
    );
    highp vec4 scaling = texelFetchOffset(transformations, idx, 0, ivec2(0, 1));
    
    #ifdef MATERIAL_ID
    fragMaterialId = uint(scaling.w);
    #endif

    highp vec3 posWorld;
    highp vec3 posView;

    #ifdef LOOKAT
    // Calculate world position of the object's origin (center)
    highp vec3 centerWorld = quat2_transformPoint(Quat2(transform[0], transform[1]), vec3(0.0));
    
    // Y-axis only billboard (cylindrical) facing the camera
    highp vec3 up = vec3(0.0, 1.0, 0.0);
    highp vec3 dir = viewPositionWorld - centerWorld;
    dir.y = 0.0;
    if (length(dir) > 0.0001) {
        dir = normalize(dir);
    } else {
        dir = vec3(0.0, 0.0, 1.0);
    }
    
    // "and that also flip it" -> invert the facing direction
    dir = -dir;
    
    highp vec3 right = cross(up, dir);
    
    // Construct world position without changing X and Z of the center
    posWorld = centerWorld + right * (-scaling.x * inPosition.x) + up * (scaling.y * inPosition.y) + dir * (-scaling.z * inPosition.z);
    posView = quat2_transformPoint(Quat2(worldToView[0], worldToView[1]), posWorld);
    #else
    posWorld = quat2_transformPoint(Quat2(transform[0], transform[1]), scaling.xyz * inPosition);
    posView = quat2_transformPoint(Quat2(worldToView[0], worldToView[1]), posWorld);
    #endif
    
    #ifdef POSITION_WORLD
    fragPositionWorld = posWorld;
    #endif
    
    #ifdef POSITION_VIEW
    fragPositionView = posView;
    #endif
    
    gl_Position = projectionMatrix * vec4(posView, 1.0);

    #ifdef TEXTURE_COORDS
    fragTextureCoords = inTextureCoords;
    #endif

    #ifdef COLOR
    fragColor = inColor;
    #endif
}
