import {Component, Object3D} from '@wonderlandengine/api';
import {property} from '@wonderlandengine/api/decorators.js';

/**
 * Copies world position from a target object but discards the Y axis.
 * Useful for making a fog cylinder follow the player on an infinite terrain.
 */
export class FollowXZ extends Component {
    static TypeName = 'follow-xz';

    @property.object()
    target!: Object3D;

    private _selfPos = new Float32Array(3);
    private _targetPos = new Float32Array(3);

    update(dt: number) {
        if (!this.target) return;

        this.target.getPositionWorld(this._targetPos);
        this.object.getPositionWorld(this._selfPos);

        this._selfPos[0] = this._targetPos[0];
        /* keep own Y */
        this._selfPos[2] = this._targetPos[2];

        this.object.setPositionWorld(this._selfPos);
    }
}
