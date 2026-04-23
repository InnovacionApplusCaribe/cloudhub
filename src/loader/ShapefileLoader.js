
import * as THREE from "../../libs/three.js/build/three.module.js";
import { GisLayer } from "../utils/GisLayer.js";

export class ShapefileLoader {

	constructor() {
		this.transform = null;
		this.offset = new THREE.Vector3(0, 0, 0);
		this.defaultZ = null;
	}

	async load(path, color = 0x00FF41) {
		const features = await this.loadShapefileFeatures(path);
		const node = new GisLayer("Shapefile Layer");
		node.color = color;
		const threeColor = new THREE.Color(color);

		let transform = this.transform;
		if (transform === null) {
			transform = { forward: (v) => v };
		}

		if (features.length > 0) {
			let firstGeom = features[0].geometry;
			let sampleCoords = null;
			if (firstGeom && firstGeom.type === "Point") {
				sampleCoords = firstGeom.coordinates;
			} else if (firstGeom && firstGeom.type === "LineString" && firstGeom.coordinates.length > 0) {
				sampleCoords = firstGeom.coordinates[0];
			} else if (firstGeom && (firstGeom.type === "Polygon" || firstGeom.type === "MultiPolygon") && firstGeom.coordinates.length > 0) {
				const poly = firstGeom.type === "Polygon" ? firstGeom.coordinates : firstGeom.coordinates[0];
				if (poly.length > 0 && poly[0].length > 0) {
					sampleCoords = poly[0][0];
				}
			}

			// Heuristic: If coordinate values are completely outside WGS84 Long/Lat bounds, 
			// it means they are already projected, so we should skip WGS84->Local projection.
			if (sampleCoords && this.transform !== null) {
				if (Math.abs(sampleCoords[0]) > 180 || Math.abs(sampleCoords[1]) > 90) {
					console.warn("Shapefile coordinates appear to be already projected. Skipping WGS84 transform.");
					transform = { forward: (v) => v };
				}
			}
		}

		const pointPositions = [];
		const linePositions = [];
		const shapesArray = [];

		if (this.defaultZ === null) {
			this.defaultZ = this.offset.z;
		}
		const defaultZ = this.defaultZ;

		for (const feature of features) {
			const geometry = feature.geometry;
			if (!geometry) continue;

			if (geometry.type === "Point") {
				const [long, lat] = geometry.coordinates;
				const zInput = geometry.coordinates[2] || defaultZ;
				// transform.forward already includes CRS projection AND offset adjustment
				const p = transform.forward([long, lat, zInput]);

				// Explicitly subtract pointcloud offset to avoid Earcut/precision errors
				const x = p[0] - this.offset.x;
				const y = p[1] - this.offset.y;
				const z = (p[2] !== undefined ? p[2] : zInput) - this.offset.z;

				geometry.coordinates = [x, y, z]; // Update for picking
				pointPositions.push(x, y, z);
			} else if (geometry.type === "LineString") {
				const coords = geometry.coordinates;
				for (let i = 0; i < coords.length; i++) {
					const zInput = coords[i][2] || defaultZ;
					// transform.forward already handles CRS projection and offset
					const p = transform.forward([coords[i][0], coords[i][1], zInput]);

					const x = p[0] - this.offset.x;
					const y = p[1] - this.offset.y;
					const z = (p[2] !== undefined ? p[2] : zInput) - this.offset.z;

					coords[i] = [x, y, z]; // Update for picking

					if (i < coords.length - 1) {
						const nextZInput = coords[i + 1][2] || defaultZ;
						const nextP = transform.forward([coords[i + 1][0], coords[i + 1][1], nextZInput]);

						const nextX = nextP[0] - this.offset.x;
						const nextY = nextP[1] - this.offset.y;
						const nextZ = (nextP[2] !== undefined ? nextP[2] : nextZInput) - this.offset.z;

						linePositions.push(x, y, z);
						linePositions.push(nextX, nextY, nextZ);
					}
				}
			} else if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
				const parsePolygon = (polygonCoords) => {
					if (!polygonCoords || polygonCoords.length === 0) return;

					let shape = new THREE.Shape();
					let shapeZ = defaultZ;  // Will store transformed Z coordinate
					let outerRing = polygonCoords[0];

					for (let i = 0; i < outerRing.length; i++) {
						const zInput = outerRing[i][2] !== undefined ? outerRing[i][2] : defaultZ;

						// transform.forward already handles all coordinate transformations
						const p = transform.forward([outerRing[i][0], outerRing[i][1], zInput]);

						const x = p[0] - this.offset.x;
						const y = p[1] - this.offset.y;
						const z = (p[2] !== undefined ? p[2] : zInput) - this.offset.z;

						if (i === 0) {
							shapeZ = z;  // Store the first (transformed) Z value
						}

						outerRing[i] = [x, y, z]; // Update for picking

						if (i === 0) shape.moveTo(x, y);
						else shape.lineTo(x, y);
					}

					for (let r = 1; r < polygonCoords.length; r++) {
						let hole = new THREE.Path();
						let holeRing = polygonCoords[r];
						for (let i = 0; i < holeRing.length; i++) {
							const zInput = holeRing[i][2] !== undefined ? holeRing[i][2] : defaultZ;
							const p = transform.forward([holeRing[i][0], holeRing[i][1], zInput]);

							const x = p[0] - this.offset.x;
							const y = p[1] - this.offset.y;
							const z = (p[2] !== undefined ? p[2] : zInput) - this.offset.z;

							holeRing[i] = [x, y, z]; // Update for picking

							if (i === 0) hole.moveTo(x, y);
							else hole.lineTo(x, y);
						}
						shape.holes.push(hole);
					}

					// Store the transformed Z coordinate (already adjusted for offset)
					shape.zOffset = shapeZ;
					shapesArray.push(shape);
				};

				if (geometry.type === "Polygon") {
					parsePolygon(geometry.coordinates);
				} else {
					for (const polyCoords of geometry.coordinates) {
						parsePolygon(polyCoords);
					}
				}
			}
		}

		// ━━━ ENHANCED VISUALIZATION: Match Measurements Tool Aesthetic ━━━

		// Create 3D Point Markers (NOT flat points like PointsMaterial)
		if (pointPositions.length > 0) {
			const pointGroup = new THREE.Group();
			pointGroup.name = "Point Markers";

			const sphereGeometry = new THREE.SphereGeometry(0.8, 12, 12);  // Like Measure tool
			const pointMaterial = new THREE.MeshLambertMaterial({
				color: threeColor,
				depthTest: false,
				depthWrite: false
			});

			// Create individual sphere meshes for each point
			for (let i = 0; i < pointPositions.length; i += 3) {
				const sphere = new THREE.Mesh(sphereGeometry, pointMaterial);
				sphere.position.set(pointPositions[i], pointPositions[i + 1], pointPositions[i + 2]);
				sphere.scale.set(1, 1, 1);
				pointGroup.add(sphere);
			}

			node.pointsMesh = pointGroup;
			node.add(pointGroup);
		}

		// Create Lines with Enhanced Styling
		if (linePositions.length > 0) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));

			// Use LineBasicMaterial with enhanced visibility
			const material = new THREE.LineBasicMaterial({
				color: threeColor,
				linewidth: 3,  // Note: only works on some systems; we'll handle via ShaderMaterial if needed
				depthTest: false,  // Always render on top
				depthWrite: false,
				transparent: true,
				opacity: 0.95
			});

			const segments = new THREE.LineSegments(geometry, material);
			segments.renderOrder = 10;
			node.linesMesh = segments;
			node.add(segments);
		}

		// Create Polygon Meshes with Semi-Transparent Fill
		if (shapesArray.length > 0) {
			const polygonGroup = new THREE.Group();
			polygonGroup.name = "Polygons";

			const GeometryClass = THREE.ShapeBufferGeometry || THREE.ShapeGeometry;

			// Material for polygon fills (semi-transparent)
			const fillMaterial = new THREE.MeshLambertMaterial({
				color: threeColor,
				opacity: 0.40,  // Semi-transparent
				transparent: true,
				side: THREE.DoubleSide,
				depthTest: false,
				depthWrite: false,
				wireframe: false
			});

			// Material for polygon outlines (solid edges)
			const outlineMaterial = new THREE.LineBasicMaterial({
				color: threeColor,
				linewidth: 2,
				depthTest: false,
				depthWrite: false,
				transparent: true,
				opacity: 1.0
			});

			// Create mesh for each shape with both fill and outline
			for (const shape of shapesArray) {
				const geometry = new GeometryClass(shape);
				const shapeZ = shape.zOffset !== undefined ? shape.zOffset : 0;

				// Set Z coordinate for filled mesh
				if (geometry.attributes && geometry.attributes.position) {
					const posAttr = geometry.attributes.position;
					for (let i = 0; i < posAttr.count; i++) {
						posAttr.setZ(i, shapeZ);
					}
				} else if (geometry.vertices) {
					for (let i = 0; i < geometry.vertices.length; i++) {
						geometry.vertices[i].z = shapeZ;
					}
				}

				// Create filled mesh
				const fillMesh = new THREE.Mesh(geometry, fillMaterial);
				fillMesh.renderOrder = 10;
				polygonGroup.add(fillMesh);

				// Create outline edges (separate geometry for better visibility)
				const outlineGeometry = new THREE.EdgesGeometry(geometry, 0.1);
				const outlineMesh = new THREE.LineSegments(outlineGeometry, outlineMaterial);
				outlineMesh.position.copy(fillMesh.position);
				outlineMesh.renderOrder = 11;  // Render on top of fill
				polygonGroup.add(outlineMesh);
			}

			node.polygonMesh = polygonGroup;
			node.add(polygonGroup);
		}

		node.setFeatures(features, node);

		return {
			features: features,
			node: node
		};
	}

	async loadShapefileFeatures(file) {
		let features = [];
		
		// To prevent the shapefile library from incorrectly appending extensions 
		// to URLs with SAS tokens (e.g. ...sig=ABC -> ...sig=ABC.shp),
		// we manually fetch the buffers ourselves.
		let shpBuffer, dbfBuffer;

		const getProxiedUrl = (url) => {
			if (url && url.includes('.blob.core.windows.net')) {
				return `/api/proxy-layer?url=${encodeURIComponent(url)}`;
			}
			return url;
		};

		try {
			const shpRes = await fetch(getProxiedUrl(file));
			if (!shpRes.ok) throw new Error(`Failed to fetch SHP: ${shpRes.statusText}`);
			shpBuffer = await shpRes.arrayBuffer();

			// Calculate DBF URL correctly from original URL
			let dbfUrl = file;
			if (typeof file === 'string') {
				const urlObj = new URL(file, window.location.origin);
				urlObj.pathname = urlObj.pathname.replace(/\.shp$/i, '.dbf');
				dbfUrl = urlObj.toString();
			}

			const dbfRes = await fetch(getProxiedUrl(dbfUrl));
			if (dbfRes.ok) {
				dbfBuffer = await dbfRes.arrayBuffer();
			}
		} catch (err) {
			console.error("[ShapefileLoader] Fetch error:", err);
			throw err;
		}

		// Open with buffers directly
		let source = await shapefile.open(shpBuffer, dbfBuffer);
		while (true) {
			let result = await source.read();
			if (result.done) break;

			if (result.value && result.value.type === 'Feature' && result.value.geometry !== undefined) {
				features.push(result.value);
			}
		}
		return features;
	}

};
