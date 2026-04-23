
import * as THREE from "../../libs/three.js/build/three.module.js";

export class GisFeature {
	constructor(layer, feature, id) {
		this.layer = layer;
		this.feature = feature;
		this.id = id;
		this.name = feature.properties && (feature.properties.Name || feature.properties.id || feature.properties.NAME) ? 
					(feature.properties.Name || feature.properties.id || feature.properties.NAME) : `Feature ${id}`;
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

		this.pointsMesh = null;
		this.polygonMesh = null;
		this.linesMesh = null;

		this._listeners = {
			"click": [],
			"select": [],
			"deselect": []
		};

		this.addEventListener("click", (event) => {
			const viewer = event.viewer;
			const camera = viewer.scene.getActiveCamera();
			const mouse = viewer.inputHandler.mouse;
			const domElement = viewer.renderer.domElement;
			const ray = Potree.Utils.mouseToRay(mouse, camera, domElement.clientWidth, domElement.clientHeight);
			
			const result = this.pick(viewer, camera, ray);
			if (result && result.feature) {
				this.selectedFeature = result.feature;
				console.log(`[GisLayer] Selected feature: ${result.feature.name}`, result.feature.feature.properties);
				
				// Dispatch a custom event so the sidebar can react
				this.dispatchEvent({
					type: 'gis_feature_selected',
					feature: result.feature,
					layer: this
				});
			}
		});

		this.addEventListener("dblclick", (event) => {
			const viewer = event.viewer;
			const camera = viewer.scene.getActiveCamera();
			const mouse = viewer.inputHandler.mouse;
			const domElement = viewer.renderer.domElement;
			const ray = Potree.Utils.mouseToRay(mouse, camera, domElement.clientWidth, domElement.clientHeight);
			
			const result = this.pick(viewer, camera, ray);
			if (result && result.feature) {
				let geom = result.feature.feature.geometry;
				if(geom) {
					let box = new THREE.Box3();
					if(geom.type === "Point"){
						let p = new THREE.Vector3(...geom.coordinates);
						box.expandByPoint(p);
						box.expandByScalar(15); 
					} else if (geom.type === "LineString") {
						for(let c of geom.coordinates) {
							box.expandByPoint(new THREE.Vector3(...c));
						}
					} else if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
						let rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
						for(let ring of rings) {
							for(let c of ring) {
								box.expandByPoint(new THREE.Vector3(...c));
							}
						}
					}
					
					let targetNode = new THREE.Object3D();
					targetNode.boundingBox = box;
					viewer.zoomTo(targetNode, 1, 500);
				}
			}
		});

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
			if (intersection.object.parent === this) {
				intersection.object = this;
			}
		}
	}

	update() {
		// No-op to satisfy MeasuringTool loop
	}

	setFeatures(rawFeatures, node) {
		this.pointsMesh = node.pointsMesh || null;
		this.polygonMesh = node.polygonMesh || null;
		this.linesMesh = node.linesMesh || null;
		this.features = rawFeatures.map((f, i) => new GisFeature(this, f, i + 1));
	}

	/**
	 * Potree picking system integration.
	 * Returns information about the feature at the ray intersection.
	 */
	pick(viewer, camera, ray, params = {}) {
		if (this.features.length === 0) return null;

		// Transform ray into local space of the layer
		const localRay = ray.clone();
		this.updateMatrixWorld();
		const inverseMatrix = new THREE.Matrix4().getInverse(this.matrixWorld);
		localRay.applyMatrix4(inverseMatrix);

		let minDistance = params.precision || 5.0; // Distance threshold for "hitting" a vector
		let closestFeature = null;

		for (const gisFeature of this.features) {
			if(!gisFeature.visible) continue;
			const geom = gisFeature.feature.geometry;
			if (!geom) continue;

			if (geom.type === "Point") {
				const dist = localRay.distanceToPoint(new THREE.Vector3(...geom.coordinates));
				if (dist < minDistance) {
					minDistance = dist;
					closestFeature = gisFeature;
				}
			} else if (geom.type === "LineString") {
				for (let i = 0; i < geom.coordinates.length - 1; i++) {
					const p1 = new THREE.Vector3(...geom.coordinates[i]);
					const p2 = new THREE.Vector3(...geom.coordinates[i + 1]);
					const dist = localRay.distanceSqToSegment(p1, p2);
					if (dist < minDistance * minDistance) {
						minDistance = Math.sqrt(dist);
						closestFeature = gisFeature;
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
						}
					}
				}
			}
		}

		if (closestFeature) {
			console.log(`[GisLayer] Feature picked:`, closestFeature.feature.properties);
			return {
				object: this,
				feature: closestFeature,
				distance: minDistance
			};
		}

		return null;
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
