import {
	Component,
	Material,
	Mesh,
	MeshAttribute,
	MeshComponent,
	Object3D,
	ParticleEffect,
	ParticleEffectComponent,
} from "@wonderlandengine/api";
import {property} from "@wonderlandengine/api/decorators.js";
import {vec3} from "gl-matrix";
import {findFloatingOrigin, type FloatingOriginSource} from "./floating-origin.js";
import {WasdMovement} from "./wasd-movement.js";

const VERTICES_PER_BLADE = 3;
const DEFAULT_VERTEX_LIMIT = 64000;
const MAX_INSTANCED_BLADES_PER_EFFECT = 60000;

const tempParticleTransform = new Float32Array(8);
const tempParticleScaling = new Float32Array(3);

type BlockCenter = [number, number];

export class SimpleCircularGrass extends Component {
	static TypeName = "simpleCircularGrass";
	static UpdateAfter = [WasdMovement];

	// editor properties
	@property.float(100.0) radius!: number;
	@property.float(10.0) blockSide!: number;
	@property.int(180) bladesPerBlock!: number;
	@property.float(0.8) bladeHeight!: number;
	@property.float(0.4) bladeHeightVariation!: number;
	@property.float(0.08) bladeWidth!: number;
	@property.material() material!: Material;
	@property.object() terrain!: Object3D;
	@property.bool(false) useCircularMask!: boolean;
	@property.bool(false) useInstancing!: boolean;

	private _instancedBladeMesh: Mesh | null = null;
	private _particleEffects: ParticleEffect[] = [];
	private _particleComponents: ParticleEffectComponent[] = [];
	private _generatedObjects: Object3D[] = [];
	private _generatedMeshes: Mesh[] = [];
	private _floatingOrigin: FloatingOriginSource | null = null;
	private _lastOriginVersion = -1;
	private _logicalAnchor = new Float64Array(3);
	private _renderAnchor = new Float32Array(3);

	get wrapSize(): number {
		return this._getGridCount() * this.blockSide;
	}

	get renderDistance(): number {
		return this.wrapSize * 0.5;
	}

	start() {
		if (!this.material) {
			console.warn("SimpleCircularGrass: no material assigned");
			return;
		}

		this.object.getPositionWorld(this._renderAnchor);
		this._logicalAnchor[0] = this._renderAnchor[0];
		this._logicalAnchor[1] = this._renderAnchor[1];
		this._logicalAnchor[2] = this._renderAnchor[2];
		this._floatingOrigin = findFloatingOrigin(this.terrain || this.object);
		this._syncRenderAnchor(true);

		if (this.useInstancing) {
			try {
				this._buildInstancedGrass();
				return;
			} catch (error) {
				this._clearGeneratedResources();
				console.warn(
					"SimpleCircularGrass: instanced path failed, falling back to legacy rendering.",
				);
				console.error(error);
			}
		}

		this._buildGridBlocks();
	}

	update() {
		if (!this._floatingOrigin) {
			this._floatingOrigin = findFloatingOrigin(this.terrain || this.object);
		}

		this._syncRenderAnchor(false);
	}

	onDestroy() {
		this._clearGeneratedResources();

		if (this._instancedBladeMesh) {
			try {
				this._instancedBladeMesh.destroy();
			} catch {}
			this._instancedBladeMesh = null;
		}
	}

	_lerpColor(t: number): [number, number, number, number] {
		const base = [0.0, 0.0, 0.0];
		const tip = [0.15, 0.65, 0.22];
		return [
			base[0] * (1 - t) + tip[0] * t,
			base[1] * (1 - t) + tip[1] * t,
			base[2] * (1 - t) + tip[2] * t,
			1.0,
		];
	}

	_addTriangle(
		positions: Float32Array,
		normals: Float32Array,
		colors: Float32Array,
		uvs: Float32Array,
		indices: Uint32Array,
		offsets: {
			pos: number;
			norm: number;
			col: number;
			uv: number;
			idx: number;
			vCount: number;
		},
		verts: number[][],
		normal: vec3,
		baseColor: number[],
		tipColor: number[],
		bladeRoot: [number, number],
		reverse = false,
	) {
		for (const v of verts) {
			positions.set(v, offsets.pos);
			offsets.pos += 3;
		}

		for (let i = 0; i < 3; i++) {
			const n = reverse ? [-normal[0], -normal[1], -normal[2]] : normal;
			normals.set(n, offsets.norm);
			offsets.norm += 3;
		}

		const cols = [baseColor, baseColor, tipColor];
		for (const c of cols) {
			colors.set(c, offsets.col);
			offsets.col += 4;
		}

		uvs.set(
			[
				bladeRoot[0], bladeRoot[1],
				bladeRoot[0], bladeRoot[1],
				bladeRoot[0], bladeRoot[1],
			],
			offsets.uv,
		);
		offsets.uv += 6;

		const v = offsets.vCount;
		if (reverse) {
			indices.set([v, v + 2, v + 1], offsets.idx);
		} else {
			indices.set([v, v + 1, v + 2], offsets.idx);
		}
		offsets.idx += 3;
		offsets.vCount += 3;
	}

	_buildGridBlocks() {
		const gridCount = this._getGridCount();
		const actualRadius = this.renderDistance;
		const halfSide = this.blockSide * 0.5;

		if (this.bladesPerBlock * VERTICES_PER_BLADE > DEFAULT_VERTEX_LIMIT) {
			console.warn("SimpleCircularGrass: bladesPerBlock too high");
		}

		const tmpE1 = vec3.create(),
			tmpE2 = vec3.create(),
			tmpN = vec3.create();
		const baseColor = this._lerpColor(0.0),
			tipColor = this._lerpColor(1.0);

		let createdBlocks = 0;
		for (let ix = 0; ix < gridCount; ix++) {
			for (let iz = 0; iz < gridCount; iz++) {
				const cx = -actualRadius + halfSide + ix * this.blockSide;
				const cz = -actualRadius + halfSide + iz * this.blockSide;
				if (this.useCircularMask && Math.hypot(cx, cz) > actualRadius)
					continue;

				const blockObj = this.object.addChild();
				blockObj.setPositionLocal([cx, 0, cz]);
				this._generatedObjects.push(blockObj);

				const vertsPerBlock = this.bladesPerBlock * VERTICES_PER_BLADE;
				const positions = new Float32Array(vertsPerBlock * 3);
				const normals = new Float32Array(vertsPerBlock * 3);
				const colors = new Float32Array(vertsPerBlock * 4);
				const uvs = new Float32Array(vertsPerBlock * 2);
				const indices = new Uint32Array(this.bladesPerBlock * 3);

				const off = {pos: 0, norm: 0, col: 0, uv: 0, idx: 0, vCount: 0};

				for (let b = 0; b < this.bladesPerBlock; b++) {
					const [lx, lz] = this._getBladeLocalOffset(
						b,
						this.bladesPerBlock,
						Math.random,
					);
					const height =
						this.bladeHeight +
						Math.random() * this.bladeHeightVariation;
					const yaw = Math.random() * Math.PI * 2;
					const sinYaw = Math.sin(yaw),
						cosYaw = Math.cos(yaw);
					const halfW = this.bladeWidth * 0.5;

					const bl = [
						lx + sinYaw * halfW,
						0.0,
						lz - cosYaw * halfW,
					];
					const br = [
						lx - sinYaw * halfW,
						0.0,
						lz + cosYaw * halfW,
					];
					const bend = (Math.random() - 0.5) * 0.6;
					const tip = [
						lx + Math.sin(yaw + bend) * 0.15,
						height,
						lz - Math.cos(yaw + bend) * 0.15,
					];

					vec3.subtract(tmpE1, br, bl);
					vec3.subtract(tmpE2, tip, bl);
					vec3.cross(tmpN, tmpE1, tmpE2);
					vec3.normalize(tmpN, tmpN);

					this._addTriangle(
						positions,
						normals,
						colors,
						uvs,
						indices,
						off,
						[bl, br, tip],
						tmpN,
						baseColor,
						tipColor,
						[lx, lz],
						false,
					);
				}

				const mesh = this.engine.meshes.create({
					vertexCount: positions.length / 3,
					indexData: indices,
				});
				mesh.attribute(MeshAttribute.Position)?.set(0, positions);
				mesh.attribute(MeshAttribute.Color)?.set(0, colors);
				mesh.attribute(MeshAttribute.TextureCoordinate)?.set(0, uvs);
				mesh.attribute(MeshAttribute.Normal)?.set(0, normals);
				mesh.update();
				this._generatedMeshes.push(mesh);

				blockObj.addComponent(MeshComponent, {
					mesh,
					material: this.material,
				});
				createdBlocks++;
			}
		}

		console.log(
			`SimpleCircularGrass: legacy path created ${createdBlocks} blocks (grid=${gridCount}, renderDistance=${actualRadius}, bladesPerBlock=${this.bladesPerBlock})`,
		);
	}

	private _buildInstancedGrass() {
		if (!this.engine.particleEffects) {
			throw new Error("Particle effects manager is unavailable in this runtime.");
		}

		const centers = this._getBlockCenters();
		const totalBlades = centers.length * this.bladesPerBlock;
		if (totalBlades <= 0) return;

		const bladeMesh = this._createInstancedBladeMesh();
		this._instancedBladeMesh = bladeMesh;

		let seed = 1234567;
		const random = () => {
			seed = (seed * 1664525 + 1013904223) | 0;
			return (seed >>> 0) / 4294967296;
		};

		let spawnedTotal = 0;
		let batchIndex = 0;

		for (
			let bladeStart = 0;
			bladeStart < totalBlades;
			bladeStart += MAX_INSTANCED_BLADES_PER_EFFECT
		) {
			const batchCount = Math.min(
				MAX_INSTANCED_BLADES_PER_EFFECT,
				totalBlades - bladeStart,
			);

			const emitter = this.object.addChild();
			this._generatedObjects.push(emitter);
			const effect = this.engine.particleEffects.create({
				maxCount: batchCount,
				mesh: bladeMesh,
				material: this.material,
				colors: false,
				instanceData: false,
			});
			const component = emitter.addComponent("particle-effect", {
				particleEffect: effect,
			}) as ParticleEffectComponent;

			this._particleEffects.push(effect);
			this._particleComponents.push(component);

			component.spawn(batchCount, 0.0);
			const transforms = component.transforms;
			const scalings = component.scalings;
			if (!transforms || !scalings) {
				throw new Error("Particle effect attribute accessors are unavailable.");
			}

			for (let localIndex = 0; localIndex < batchCount; ++localIndex) {
				const bladeIndex = bladeStart + localIndex;
				const [cx, cz] = centers[Math.floor(bladeIndex / this.bladesPerBlock)];
				const bladeIndexInBlock = bladeIndex % this.bladesPerBlock;

				const [localX, localZ] = this._getBladeLocalOffset(
					bladeIndexInBlock,
					this.bladesPerBlock,
					random,
				);
				const px = cx + localX;
				const pz = cz + localZ;
				const yaw = random() * Math.PI * 2;
				const height =
					this.bladeHeight + random() * this.bladeHeightVariation;
				const width =
					this.bladeWidth * (0.85 + random() * 0.3);

				this._writeParticleTransform(px, 0.0, pz, yaw);
				transforms.set(localIndex, tempParticleTransform);

				tempParticleScaling[0] = width;
				tempParticleScaling[1] = height;
				tempParticleScaling[2] = Math.max(width, 0.01);
				scalings.set(localIndex, tempParticleScaling);
			}

			component.update(batchCount);
			spawnedTotal += batchCount;
			batchIndex++;
		}

		console.log(
			`SimpleCircularGrass: instanced path spawned ${spawnedTotal} blades using ${batchIndex} particle emitters`,
		);
	}

	private _createInstancedBladeMesh() {
		const mesh = this.engine.meshes.create({
			vertexCount: 3,
			indexData: new Uint16Array([0, 1, 2]),
		});
		const baseColor = this._lerpColor(0.0);
		const tipColor = this._lerpColor(1.0);

		mesh.attribute(MeshAttribute.Position)?.set(
			0,
			new Float32Array([
				-0.5, 0.0, 0.0,
				 0.5, 0.0, 0.0,
				 0.0, 1.0, 0.0,
			]),
		);
		mesh.attribute(MeshAttribute.Normal)?.set(
			0,
			new Float32Array([
				0.0, 0.0, 1.0,
				0.0, 0.0, 1.0,
				0.0, 0.0, 1.0,
			]),
		);
		mesh.attribute(MeshAttribute.Color)?.set(
			0,
			new Float32Array([
				baseColor[0], baseColor[1], baseColor[2], baseColor[3],
				baseColor[0], baseColor[1], baseColor[2], baseColor[3],
				tipColor[0], tipColor[1], tipColor[2], tipColor[3],
			]),
		);
		mesh.attribute(MeshAttribute.TextureCoordinate)?.set(
			0,
			new Float32Array([
				0.0, 0.0,
				0.0, 0.0,
				0.0, 0.0,
			]),
		);
		mesh.update();
		return mesh;
	}

	private _writeParticleTransform(
		x: number,
		y: number,
		z: number,
		yaw: number,
	) {
		const halfYaw = yaw * 0.5;
		const qx = 0.0;
		const qy = Math.sin(halfYaw);
		const qz = 0.0;
		const qw = Math.cos(halfYaw);

		const dx = 0.5 * (qw * x + y * qz - z * qy);
		const dy = 0.5 * (qw * y + z * qx - x * qz);
		const dz = 0.5 * (qw * z + x * qy - y * qx);
		const dw = -0.5 * (x * qx + y * qy + z * qz);

		tempParticleTransform[0] = qx;
		tempParticleTransform[1] = qy;
		tempParticleTransform[2] = qz;
		tempParticleTransform[3] = qw;
		tempParticleTransform[4] = dx;
		tempParticleTransform[5] = dy;
		tempParticleTransform[6] = dz;
		tempParticleTransform[7] = dw;
	}

	private _getBlockCenters(): BlockCenter[] {
		const gridCount = this._getGridCount();
		const actualRadius = this.renderDistance;
		const halfSide = this.blockSide * 0.5;
		const centers: BlockCenter[] = [];

		for (let ix = 0; ix < gridCount; ++ix) {
			for (let iz = 0; iz < gridCount; ++iz) {
				const cx = -actualRadius + halfSide + ix * this.blockSide;
				const cz = -actualRadius + halfSide + iz * this.blockSide;
				if (this.useCircularMask && Math.hypot(cx, cz) > actualRadius) {
					continue;
				}
				centers.push([cx, cz]);
			}
		}

		return centers;
	}

	private _getGridCount() {
		const desiredTotal = 2 * Math.max(0.0001, this.radius);
		return Math.max(1, Math.round(desiredTotal / this.blockSide));
	}

	private _getBladeLocalOffset(
		bladeIndex: number,
		bladeCount: number,
		random: () => number,
	): [number, number] {
		const safeBladeCount = Math.max(1, bladeCount);
		const gridSide = Math.max(1, Math.ceil(Math.sqrt(safeBladeCount)));
		const totalCells = gridSide * gridSide;
		const cellSize = this.blockSide / gridSide;
		const halfSide = this.blockSide * 0.5;

		const mappedIndex = Math.min(
			totalCells - 1,
			Math.floor(((bladeIndex + 0.5) * totalCells) / safeBladeCount),
		);
		const row = Math.floor(mappedIndex / gridSide);
		let col = mappedIndex - row * gridSide;

		// Serpentine ordering avoids a visible directional fill bias.
		if ((row & 1) === 1) {
			col = gridSide - 1 - col;
		}

		const jitter = cellSize * 0.82;
		const jitterX = (random() - 0.5) * jitter;
		const jitterZ = (random() - 0.5) * jitter;

		const lx = -halfSide + (col + 0.5) * cellSize + jitterX;
		const lz = -halfSide + (row + 0.5) * cellSize + jitterZ;
		return [lx, lz];
	}

	private _syncRenderAnchor(force: boolean) {
		const floatingOrigin = this._floatingOrigin;
		const originVersion = floatingOrigin?.originVersion ?? 0;

		if (!force && originVersion === this._lastOriginVersion) {
			return;
		}

		if (floatingOrigin) {
			floatingOrigin.toRenderPosition(
				this._logicalAnchor[0],
				this._logicalAnchor[1],
				this._logicalAnchor[2],
				this._renderAnchor,
			);
		} else {
			this._renderAnchor[0] = this._logicalAnchor[0];
			this._renderAnchor[1] = this._logicalAnchor[1];
			this._renderAnchor[2] = this._logicalAnchor[2];
		}

		this.object.setPositionWorld(this._renderAnchor);
		this._lastOriginVersion = originVersion;
	}

	private _clearGeneratedResources() {
		for (const comp of this._particleComponents) {
			try {
				comp.particleEffect = null;
			} catch {}
		}
		this._particleComponents.length = 0;

		for (const effect of this._particleEffects) {
			try {
				effect.destroy();
			} catch {}
		}
		this._particleEffects.length = 0;

		for (const obj of this._generatedObjects) {
			try {
				obj.destroy();
			} catch {}
		}
		this._generatedObjects.length = 0;

		for (const mesh of this._generatedMeshes) {
			try {
				mesh.destroy();
			} catch {}
		}
		this._generatedMeshes.length = 0;
	}
}
