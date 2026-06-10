
import * as THREE from "../../libs/three.js/build/three.module.js";

export class GisFeature {
	constructor(layer, feature, id) {
		this.layer = layer;
		this.feature = feature;
		this.id = id;
		
		const props = feature.properties || {};
		const geomType = feature.geometry ? feature.geometry.type : "Unknown";
		
		// Logic requested by user:
		// Point: Extract ID
		// Polygon: Extract ID and Risk Type
		
		let nameParts = [];
		
		// Find ID (case-insensitive)
		const idKey = Object.keys(props).find(k => k.toLowerCase() === "id");
		if (idKey) {
			nameParts.push(`ID: ${props[idKey]}`);
		}
		
		// Find Risk Type (case-insensitive) for Polygons
		if (geomType.includes("Polygon")) {
			const riskKey = Object.keys(props).find(k => k.toLowerCase().includes("risk"));
			if (riskKey) {
				nameParts.push(`Risk: ${props[riskKey]}`);
			}
		}
		
		if (nameParts.length > 0) {
			this.name = nameParts.join(" | ");
		} else {
			// Fallback to existing logic
			this.name = props.Name || props.NAME || props.id || props.ID || `Feature ${id}`;
		}

		this.type = "GisFeature";
		this.visible = true;
	}
}

/**
 * Represents a batched GIS layer (SHP, KML) in the Potree scene.
 * Inherits from THREE.Object3D to integrate into the scene graph,
 * but maintains a minimal interface for the sidebar tree.
 */
export class GisLayer extends THREE.Object3D {
	constructor(name) {
		super();
		this.name = name || "GIS Layer";
		this.type = "GisLayer";

		this.boundingBox = new THREE.Box3();
		this.boundingSphere = new THREE.Sphere();

		// Stubs to avoid crashes in MeasuringTool loops
		this.spheres = [];
		this.edgeLabels = [];
		this.angleLabels = [];
		this.coordinateLabels = [];
		this.sphereLabels = [];

		this.features = []; // Array of GisFeature objects
		this.selectedFeature = null;
		this._spatialIndex = null; // Grid-based spatial index for large layers

		this.pointsMesh = null;
		this.polygonMesh = null;
		this.linesMesh = null;

		this._listeners = {
			"click": [],
			"select": [],
			"deselect": []
		};

		this.highlightMesh = null;
		this._color = new THREE.Color(0x00FF41);
	}

	get color() {
		return this._color;
	}

	set color(value) {
		this._color = new THREE.Color(value);
		
		this.traverse(child => {
			if (child.material && child.material.color) {
				child.material.color.copy(this._color);
			}
		});

		this.dispatchEvent({
			type: "color_changed",
			color: this._color
		});
	}

	raycast(raycaster, intersects) {
		for (let child of this.children) {
			child.raycast(raycaster, intersects);
		}
		
		for (let intersection of intersects) {
			let obj = intersection.object;
			while (obj && obj !== this) {
				if (obj.parent === this) {
					intersection.object = this;
					break;
				}
				obj = obj.parent;
			}
		}
	}

	update() {
		// No-op to satisfy MeasuringTool loop
	}

	highlightFeature(feature) {
		this.clearHighlight();

		if (!feature || !feature.feature || !feature.feature.geometry) return;

		const geom = feature.feature.geometry;
		const geomType = geom.type;
		const threeColor = new THREE.Color(0xFFFF00); // Yellow highlight color

		const group = new THREE.Group();
		group.name = "FeatureHighlight";

		const outlineMaterial = new THREE.LineBasicMaterial({
			color: threeColor,
			linewidth: 4,
			depthTest: false,
			depthWrite: false,
			transparent: true,
			opacity: 1.0
		});

		const fillMaterial = new THREE.MeshBasicMaterial({
			color: threeColor,
			opacity: 0.45,
			transparent: true,
			side: THREE.DoubleSide,
			depthTest: false,
			depthWrite: false
		});

		if (geomType === "Point") {
			const pt = new THREE.Vector3(...geom.coordinates);
			const sphereGeometry = new THREE.SphereGeometry(1.2, 16, 16);
			const mesh = new THREE.Mesh(sphereGeometry, fillMaterial);
			mesh.position.copy(pt);
			group.add(mesh);
		} else if (geomType === "LineString") {
			const positions = [];
			for (const pt of geom.coordinates) {
				positions.push(pt[0], pt[1], pt[2]);
			}
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
			const line = new THREE.Line(geometry, outlineMaterial);
			group.add(line);
		} else if (geomType === "Polygon" || geomType === "MultiPolygon") {
			const parsePolygonHighlight = (polygonCoords) => {
				if (!polygonCoords || polygonCoords.length === 0) return;
				
				const outlinePositions = [];
				for (const ring of polygonCoords) {
					for (let i = 0; i < ring.length - 1; i++) {
						outlinePositions.push(ring[i][0], ring[i][1], ring[i][2]);
						outlinePositions.push(ring[i+1][0], ring[i+1][1], ring[i+1][2]);
					}
				}
				const outGeom = new THREE.BufferGeometry();
				outGeom.setAttribute('position', new THREE.Float32BufferAttribute(outlinePositions, 3));
				const outlineMesh = new THREE.LineSegments(outGeom, outlineMaterial);
				group.add(outlineMesh);

				let shape = new THREE.Shape();
				let shapeZ = polygonCoords[0][0][2] || 0;
				
				const outerRing = polygonCoords[0];
				for (let i = 0; i < outerRing.length; i++) {
					if (i === 0) shape.moveTo(outerRing[i][0], outerRing[i][1]);
					else shape.lineTo(outerRing[i][0], outerRing[i][1]);
				}

				for (let r = 1; r < polygonCoords.length; r++) {
					const holeRing = polygonCoords[r];
					let hole = new THREE.Path();
					for (let i = 0; i < holeRing.length; i++) {
						if (i === 0) hole.moveTo(holeRing[i][0], holeRing[i][1]);
						else hole.lineTo(holeRing[i][0], holeRing[i][1]);
					}
					shape.holes.push(hole);
				}

				const GeometryClass = THREE.ShapeBufferGeometry || THREE.ShapeGeometry;
				const fillGeom = new GeometryClass(shape);
				if (fillGeom.attributes && fillGeom.attributes.position) {
					const posAttr = fillGeom.attributes.position;
					for (let j = 0; j < posAttr.count; j++) {
						posAttr.setZ(j, shapeZ);
					}
				}
				fillGeom.computeBoundingBox();
				fillGeom.computeBoundingSphere();
				const fillMesh = new THREE.Mesh(fillGeom, fillMaterial);
				group.add(fillMesh);
			};

			if (geomType === "Polygon") {
				parsePolygonHighlight(geom.coordinates);
			} else {
				for (const polyCoords of geom.coordinates) {
					parsePolygonHighlight(polyCoords);
				}
			}
		}

		this.highlightMesh = group;
		this.add(group);
	}

	clearHighlight() {
		if (this.highlightMesh) {
			this.remove(this.highlightMesh);
			this.highlightMesh.traverse(child => {
				if (child.geometry) child.geometry.dispose();
				if (child.material) {
					if (Array.isArray(child.material)) {
						child.material.forEach(m => m.dispose());
					} else {
						child.material.dispose();
					}
				}
			});
			this.highlightMesh = null;
		}
	}

	setFeatures(rawFeatures, node) {
		this.pointsMesh = node.pointsMesh || null;
		this.polygonMesh = node.polygonMesh || null;
		this.linesMesh = node.linesMesh || null;
		this.features = rawFeatures.map((f, i) => new GisFeature(this, f, i + 1));
		
		this.calculateBoundingBox();

		// Build spatial index for large layers to accelerate pick()
		if (this.features.length > 1000) {
			this._buildSpatialIndex();
		}
	}

	pick(viewer, camera, ray, params = {}) {
		if (this.features.length === 0) return null;

		// Transform ray into local space of the layer
		const localRay = ray.clone();
		this.updateMatrixWorld();
		const inverseMatrix = new THREE.Matrix4().getInverse(this.matrixWorld);
		localRay.applyMatrix4(inverseMatrix);

		let minDistance = params.precision || 5.0; // Distance threshold for "hitting" a vector
		let closestFeature = null;
		let closestPoint = null;

		// ━━━ Use spatial index for large layers (>1000 features) ━━━
		const candidateFeatures = this.features.length > 1000
			? this._getSpatialCandidates(localRay)
			: this.features;

		for (const gisFeature of candidateFeatures) {
			if(!gisFeature.visible) continue;
			const geom = gisFeature.feature.geometry;
			if (!geom) continue;

			if (geom.type === "Point") {
				const pt = new THREE.Vector3(...geom.coordinates);
				const dist = localRay.distanceToPoint(pt);
				if (dist < minDistance) {
					minDistance = dist;
					closestFeature = gisFeature;
					closestPoint = pt.clone();
				}
			} else if (geom.type === "LineString") {
				for (let i = 0; i < geom.coordinates.length - 1; i++) {
					const p1 = new THREE.Vector3(...geom.coordinates[i]);
					const p2 = new THREE.Vector3(...geom.coordinates[i + 1]);
					const dist = localRay.distanceSqToSegment(p1, p2);
					if (dist < minDistance * minDistance) {
						minDistance = Math.sqrt(dist);
						closestFeature = gisFeature;
						closestPoint = p1.clone();
					}
				}
			} else if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
				// Simple bounding box or center check could go here for polygons if needed
				// For now relying on vertex proximity like LineString
				let rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
				for (const ring of rings) {
					for (let i = 0; i < ring.length - 1; i++) {
						const p1 = new THREE.Vector3(...ring[i]);
						const p2 = new THREE.Vector3(...ring[i + 1]);
						const dist = localRay.distanceSqToSegment(p1, p2);
						if (dist < minDistance * minDistance) {
							minDistance = Math.sqrt(dist);
							closestFeature = gisFeature;
							closestPoint = p1.clone();
						}
					}
				}
			}
		}


		if (closestFeature) {
			console.log(`[GisLayer] Feature picked:`, closestFeature.feature.properties);
			
			if(closestPoint) {
				closestPoint.applyMatrix4(this.matrixWorld);
			}

			return {
				object: this,
				feature: closestFeature,
				distance: minDistance,
				point: closestPoint
			};
		}

		return null;
	}

	// ━━━ Grid-based Spatial Index ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	_buildSpatialIndex() {
		const GRID_SIZE = 32; // 32x32 grid cells
		const bb = this.boundingBox;
		if (bb.isEmpty()) {
			this._spatialIndex = null;
			return;
		}

		const min = bb.min;
		const max = bb.max;
		const dx = (max.x - min.x) || 1;
		const dy = (max.y - min.y) || 1;

		const grid = new Array(GRID_SIZE * GRID_SIZE);
		for (let i = 0; i < grid.length; i++) grid[i] = [];

		for (const gisFeature of this.features) {
			const geom = gisFeature.feature.geometry;
			if (!geom) continue;

			// Compute feature bounding box
			let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;

			const processCoords = (coords) => {
				for (const c of coords) {
					if (c[0] < fMinX) fMinX = c[0];
					if (c[1] < fMinY) fMinY = c[1];
					if (c[0] > fMaxX) fMaxX = c[0];
					if (c[1] > fMaxY) fMaxY = c[1];
				}
			};

			if (geom.type === "Point") {
				fMinX = fMaxX = geom.coordinates[0];
				fMinY = fMaxY = geom.coordinates[1];
			} else if (geom.type === "LineString") {
				processCoords(geom.coordinates);
			} else if (geom.type === "Polygon") {
				for (const ring of geom.coordinates) processCoords(ring);
			} else if (geom.type === "MultiPolygon") {
				for (const poly of geom.coordinates)
					for (const ring of poly) processCoords(ring);
			}

			if (!isFinite(fMinX)) continue;

			// Map feature bbox to grid cells
			const cellMinX = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(((fMinX - min.x) / dx) * GRID_SIZE)));
			const cellMaxX = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(((fMaxX - min.x) / dx) * GRID_SIZE)));
			const cellMinY = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(((fMinY - min.y) / dy) * GRID_SIZE)));
			const cellMaxY = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(((fMaxY - min.y) / dy) * GRID_SIZE)));

			for (let cy = cellMinY; cy <= cellMaxY; cy++) {
				for (let cx = cellMinX; cx <= cellMaxX; cx++) {
					grid[cy * GRID_SIZE + cx].push(gisFeature);
				}
			}
		}

		this._spatialIndex = { grid, gridSize: GRID_SIZE, min, dx, dy };
		console.log(`[GisLayer] Spatial index built: ${GRID_SIZE}x${GRID_SIZE} grid for ${this.features.length} features.`);
	}

	_getSpatialCandidates(localRay) {
		if (!this._spatialIndex) return this.features;

		const { grid, gridSize, min, dx, dy } = this._spatialIndex;

		// Find the ray's XY intersection with the bounding box plane
		// Use a point on the ray closest to the center of the bounding box
		const bbCenter = new THREE.Vector3(
			min.x + dx / 2,
			min.y + dy / 2,
			this.boundingBox.getCenter(new THREE.Vector3()).z
		);
		const closestPt = new THREE.Vector3();
		localRay.closestPointToPoint(bbCenter, closestPt);

		// Map to grid cell and check a 3x3 neighborhood
		const cellX = Math.floor(((closestPt.x - min.x) / dx) * gridSize);
		const cellY = Math.floor(((closestPt.y - min.y) / dy) * gridSize);

		const seen = new Set();
		const candidates = [];
		const RADIUS = 2; // Check cells in a 5x5 neighborhood

		for (let oy = -RADIUS; oy <= RADIUS; oy++) {
			for (let ox = -RADIUS; ox <= RADIUS; ox++) {
				const cx = cellX + ox;
				const cy = cellY + oy;
				if (cx < 0 || cx >= gridSize || cy < 0 || cy >= gridSize) continue;
				const cell = grid[cy * gridSize + cx];
				for (const f of cell) {
					if (!seen.has(f.id)) {
						seen.add(f.id);
						candidates.push(f);
					}
				}
			}
		}

		return candidates;
	}

	/**
	 * Computes the bounding box and sphere for camera system compatibility.
	 */
	calculateBoundingBox() {
		this.boundingBox.makeEmpty();
		this.traverse(object => {
			if (object.geometry) {
				if (!object.geometry.boundingBox) {
					object.geometry.computeBoundingBox();
				}
				this.boundingBox.union(object.geometry.boundingBox);
			}
		});
		this.boundingBox.getBoundingSphere(this.boundingSphere);
		return this.boundingBox;
	}
}
