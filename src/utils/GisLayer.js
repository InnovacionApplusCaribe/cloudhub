
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
				
				const selectionEvent = {
					type: 'gis_feature_selected',
					feature: result.feature,
					layer: this,
					point: result.point
				};

				// Create or update annotation in viewer
				if (!viewer.gisAnnotation) {
					viewer.gisAnnotation = new Potree.Annotation({
						position: [0, 0, 0],
						title: "Feature Info"
					});
					viewer.scene.annotations.add(viewer.gisAnnotation);
				}
				
				let pos = result.point ? result.point : new THREE.Vector3();
				viewer.gisAnnotation.position.copy(pos);
				
				let elPopup = $(`
					<div style="background-color: rgba(30, 30, 30, 0.95); padding: 10px; border-radius: 5px; color: white; pointer-events: auto; border: 1px solid white; min-width: 250px; font-family: Arial, Helvetica, sans-serif;">
						<div style="border-bottom: 1px solid white; margin-bottom: 5px; padding-bottom: 5px;">
							<span style="font-weight: bold; font-size: 1.1em;">Feature: ${result.feature.name}</span>
							<span class="gis-close-btn" style="float: right; cursor: pointer; color: #ff5555; margin-left: 15px; font-weight: bold;">✕</span>
						</div>
						<div style="max-height: 300px; overflow-y: auto;">
							<table class="measurement_value_table" style="width: 100%; border-collapse: collapse; text-align: left;">
								<thead>
									<tr style="background: rgba(255,255,255,0.1)">
										<th style="padding: 4px;">Field</th>
										<th style="padding: 4px;">Value</th>
									</tr>
								</thead>
								<tbody id="gis_popup_body"></tbody>
							</table>
						</div>
					</div>
				`);

				const tbody = elPopup.find("#gis_popup_body");
				const props = result.feature.feature.properties || {};
				for (const key of Object.keys(props)) {
					const val = props[key];
					const row = $(`
						<tr style="border-bottom: 1px solid rgba(255,255,255,0.05)">
							<td style="padding: 4px; font-weight: bold; font-size: 0.9em; white-space: normal;">${key}</td>
							<td style="padding: 4px; font-size: 0.9em; word-break: break-all; white-space: normal;">${val}</td>
						</tr>
					`);
					tbody.append(row);
				}

				elPopup.find(".gis-close-btn").click((e) => {
					e.stopPropagation();
					viewer.gisAnnotation.visible = false;
				});

				viewer.gisAnnotation.domElement.empty();
				viewer.gisAnnotation.domElement.append(elPopup);
				viewer.gisAnnotation.visible = true;
				viewer.gisAnnotation.domElement.css('opacity', '1');
				viewer.gisAnnotation.domElement.off('mouseenter mouseleave touchstart');

				// Dispatch on the layer itself
				this.dispatchEvent(selectionEvent);
				
				// Also dispatch on the viewer so the properties panel and other UI components can react
				viewer.dispatchEvent(selectionEvent);

				// Optional: Highlight effect if a mesh exists
				const mesh = this.polygonMesh || this.linesMesh || this.pointsMesh;
				if (mesh && mesh.material && mesh.material.color) {
					const oldColor = mesh.material.color.clone();
					mesh.material.color.setHex(0xFFFF00); // Highlight yellow
					setTimeout(() => {
						if (mesh.material) mesh.material.color.copy(oldColor);
					}, 1000);
				}
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
		
		this.calculateBoundingBox();
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

		for (const gisFeature of this.features) {
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
