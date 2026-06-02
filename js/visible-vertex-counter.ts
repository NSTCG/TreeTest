import {
    Component,
    MeshComponent,
    Object3D,
    ProjectionType,
    ViewComponent,
} from '@wonderlandengine/api';
import {property} from '@wonderlandengine/api/decorators.js';

/**
 * Logs the total vertex count of meshes that are inside the current camera
 * frustum after the scene has been rendered.
 */
export class VisibleVertexCounter extends Component {
    static TypeName = 'visible-vertex-counter';

    /** Optional view object override. Falls back to the scene main view. */
    @property.object()
    viewObject!: Object3D;

    /** Delay between logs in milliseconds. Set to 0 to log every frame. */
    @property.float(1000.0)
    updateRateMs!: number;

    private _onPostRender = this._logVisibleVertices.bind(this);
    private _lastLogTime = Number.NEGATIVE_INFINITY;

    private _sphere = new Float32Array(4);
    private _localCenter = new Float32Array(3);
    private _worldCenter = new Float32Array(3);
    private _viewCenter = new Float32Array(3);
    private _worldScale = new Float32Array(3);
    private _viewport = new Int32Array(4);

    private _near = 0.1;
    private _far = 1000.0;
    private _sinHalfFovX = 0.0;
    private _cosHalfFovX = 1.0;
    private _sinHalfFovY = 0.0;
    private _cosHalfFovY = 1.0;
    private _orthoHalfWidth = 0.5;
    private _orthoHalfHeight = 0.5;
    private _isOrthographic = false;

    onActivate() {
        this._lastLogTime = Number.NEGATIVE_INFINITY;
        this.engine.scene.onPostRender.add(this._onPostRender);
    }

    onDeactivate() {
        this.engine.scene.onPostRender.remove(this._onPostRender);
    }

    private _logVisibleVertices() {
        const now = performance.now();
        if (this.updateRateMs > 0.0 && now - this._lastLogTime < this.updateRateMs) {
            return;
        }

        const view = this._resolveView();
        if (!view || !this._prepareFrustum(view)) {
            return;
        }

        const meshes = this.engine.scene.getActiveComponents('mesh') as MeshComponent[];

        let visibleMeshCount = 0;
        let visibleVertexCount = 0;

        for (const meshComp of meshes) {
            const mesh = meshComp.mesh;
            if (!mesh) continue;

            if (!this._isMeshVisible(meshComp, view)) {
                continue;
            }

            ++visibleMeshCount;
            visibleVertexCount += mesh.vertexCount;
        }

        this._lastLogTime = now;
        console.log(
            `[visible-vertex-counter] visible vertices: ${visibleVertexCount} ` +
                `(mesh components: ${visibleMeshCount})`
        );
    }

    private _resolveView(): ViewComponent | null {
        const overrideView = this.viewObject?.getComponent('view') as ViewComponent | null;
        if (overrideView?.active) {
            return overrideView;
        }

        const scene = this.engine.scene;
        if (scene.mainView?.active) {
            return scene.mainView;
        }

        return scene.activeViews[0] ?? null;
    }

    private _prepareFrustum(view: ViewComponent): boolean {
        this._near = view.near;
        this._far = view.far;
        this._isOrthographic = view.projectionType === ProjectionType.Orthographic;

        view.getViewport(this._viewport);

        let width = this._viewport[2];
        let height = this._viewport[3];

        if (width <= 0 || height <= 0) {
            width = this.engine.canvas.width;
            height = this.engine.canvas.height;
        }

        const safeHeight = Math.max(height, 1);
        const aspect = Math.max(width / safeHeight, 0.0001);

        if (this._isOrthographic) {
            this._orthoHalfWidth = view.extent * 0.5;
            this._orthoHalfHeight = this._orthoHalfWidth / aspect;
            return true;
        }

        const halfFovX = Math.max((view.fov * Math.PI) / 360.0, 0.0001);
        const tanHalfFovX = Math.tan(halfFovX);
        const halfFovY = Math.atan(tanHalfFovX / aspect);

        this._sinHalfFovX = Math.sin(halfFovX);
        this._cosHalfFovX = Math.cos(halfFovX);
        this._sinHalfFovY = Math.sin(halfFovY);
        this._cosHalfFovY = Math.cos(halfFovY);

        return true;
    }

    private _isMeshVisible(meshComp: MeshComponent, view: ViewComponent): boolean {
        const mesh = meshComp.mesh;
        if (!mesh) return false;

        mesh.getBoundingSphere(this._sphere);

        this._localCenter[0] = this._sphere[0];
        this._localCenter[1] = this._sphere[1];
        this._localCenter[2] = this._sphere[2];

        meshComp.object.transformPointWorld(this._worldCenter, this._localCenter);
        view.object.transformPointInverseWorld(this._viewCenter, this._worldCenter);
        meshComp.object.getScalingWorld(this._worldScale);

        const radius =
            this._sphere[3] *
            Math.max(
                Math.abs(this._worldScale[0]),
                Math.abs(this._worldScale[1]),
                Math.abs(this._worldScale[2])
            );

        if (radius <= 0.0) {
            return false;
        }

        const x = this._viewCenter[0];
        const y = this._viewCenter[1];
        const depth = -this._viewCenter[2];

        if (depth + radius < this._near) return false;
        if (depth - radius > this._far) return false;

        if (this._isOrthographic) {
            if (Math.abs(x) > this._orthoHalfWidth + radius) return false;
            if (Math.abs(y) > this._orthoHalfHeight + radius) return false;
            return true;
        }

        const horizontalDistance =
            depth * this._sinHalfFovX - Math.abs(x) * this._cosHalfFovX;
        if (horizontalDistance < -radius) return false;

        const verticalDistance =
            depth * this._sinHalfFovY - Math.abs(y) * this._cosHalfFovY;
        if (verticalDistance < -radius) return false;

        return true;
    }
}
