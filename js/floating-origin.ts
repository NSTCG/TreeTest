import {Object3D} from '@wonderlandengine/api';

export interface FloatingOriginSource {
    readonly originVersion: number;
    getLogicalPosition(out: Float32Array | Float64Array): Float32Array | Float64Array;
    toRenderPosition(x: number, y: number, z: number, out: Float32Array): Float32Array;
}

let activeFloatingOrigin: FloatingOriginSource | null = null;

export function setActiveFloatingOrigin(source: FloatingOriginSource | null) {
    activeFloatingOrigin = source;
}

export function getActiveFloatingOrigin() {
    return activeFloatingOrigin;
}

export function findFloatingOrigin(
    start: Object3D | null | undefined,
): FloatingOriginSource | null {
    if (activeFloatingOrigin) {
        return activeFloatingOrigin;
    }

    let current = start ?? null;
    while (current) {
        const candidate = current.getComponent('wasd-movement') as unknown;
        if (isFloatingOriginSource(candidate)) {
            return candidate;
        }
        current = current.parent;
    }

    return null;
}

function isFloatingOriginSource(value: unknown): value is FloatingOriginSource {
    return !!value &&
        typeof value === 'object' &&
        typeof (value as FloatingOriginSource).getLogicalPosition === 'function' &&
        typeof (value as FloatingOriginSource).toRenderPosition === 'function';
}
