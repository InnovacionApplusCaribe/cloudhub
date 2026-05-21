
import * as THREE from "../../libs/three.js/build/three.module.js";
import { GisLayer } from "../utils/GisLayer.js";

export class ShapefileLoader {

	constructor() {
		this.transform = null;
		this.offset = new THREE.Vector3(0, 0, 0);
		this.defaultZ = null;
	}

	async load(path, color = 0x00FF41, onProgress = null) {
		const reportProgress = (msg, percent) => {
			if (onProgress) onProgress(msg, percent);
		};

		reportProgress("Downloading shapefile...", 0);
		const features = await this.loadShapefileFeatures(path, reportProgress);
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
		const polygonOutlinePositions = [];
		const shapesArray = [];

		if (this.defaultZ === null) {
			this.defaultZ = this.offset.z;
		}
		const defaultZ = this.defaultZ;

		const totalFeatures = features.length;
		let processedFeatures = 0;
		let lastYieldTime = performance.now();

			for (const feature of features) {
				processedFeatures++;
				
				// Yield more frequently to keep UI responsive
				if (performance.now() - lastYieldTime > 20) {
					reportProgress(`Processing feature geometries (${processedFeatures}/${totalFeatures})...`, (processedFeatures / totalFeatures) * 50);
					await new Promise(resolve => setTimeout(resolve, 0));
					lastYieldTime = performance.now();
				}

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

						if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(nextX) && !isNaN(nextY) && !isNaN(nextZ)) {
							linePositions.push(x, y, z);
							linePositions.push(nextX, nextY, nextZ);
						}
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

						if (i > 0) {
							const prev = outerRing[i - 1];
							polygonOutlinePositions.push(prev[0], prev[1], prev[2]);
							polygonOutlinePositions.push(x, y, z);
						}
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

							if (i > 0) {
								const prev = holeRing[i - 1];
								polygonOutlinePositions.push(prev[0], prev[1], prev[2]);
								polygonOutlinePositions.push(x, y, z);
							}
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
						
						// Yield within MultiPolygon for very complex features
						if (performance.now() - lastYieldTime > 20) {
							reportProgress(`Processing MultiPolygon (${processedFeatures}/${totalFeatures})...`, (processedFeatures / totalFeatures) * 50);
							await new Promise(resolve => setTimeout(resolve, 0));
							lastYieldTime = performance.now();
						}
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

			// Use InstancedMesh for high-performance point markers (Issue 1 cleanup)
			const pointCount = pointPositions.length / 3;
			const instancedMesh = new THREE.InstancedMesh(sphereGeometry, pointMaterial, pointCount);
			const dummy = new THREE.Object3D();

			for (let i = 0; i < pointCount; i++) {
				const px = pointPositions[i * 3];
				const py = pointPositions[i * 3 + 1];
				const pz = pointPositions[i * 3 + 2];
				
				if (isNaN(px) || isNaN(py) || isNaN(pz)) continue;
				
				dummy.position.set(px, py, pz);
				dummy.updateMatrix();
				instancedMesh.setMatrixAt(i, dummy.matrix);
				
				// Yield during instanced mesh setup
				if (performance.now() - lastYieldTime > 20) {
					await new Promise(resolve => setTimeout(resolve, 0));
					lastYieldTime = performance.now();
				}
			}
			instancedMesh.instanceMatrix.needsUpdate = true;
			pointGroup.add(instancedMesh);

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

			// Create batch geometries for fill and outlines
			const fillGeometries = [];
			
			// ━━━ PHASE 1: BATCH GEOMETRY GENERATION ━━━
			for (let i = 0; i < shapesArray.length; i++) {
				const shape = shapesArray[i];
				const geometry = new GeometryClass(shape);
				const shapeZ = shape.zOffset !== undefined ? shape.zOffset : 0;

				// Set Z coordinate for filled mesh
				if (geometry.attributes && geometry.attributes.position) {
					const posAttr = geometry.attributes.position;
					for (let j = 0; j < posAttr.count; j++) {
						posAttr.setZ(j, shapeZ);
					}
				}

				fillGeometries.push(geometry);

				// Yield based on time to prevent any heavy polygon from freezing
				if (performance.now() - lastYieldTime > 30) {
					reportProgress(`Building meshes (${i}/${shapesArray.length})...`, 50 + (i / shapesArray.length) * 50);
					await new Promise(resolve => setTimeout(resolve, 0));
					lastYieldTime = performance.now();
				}
			}

			if (fillGeometries.length > 0) {
				// Helper to merge geometries asynchronously to prevent UI freeze
				const mergeGeometriesAsync = async (geos) => {
					const merged = new THREE.BufferGeometry();
					let totalVertices = 0;
					let totalIndices = 0;
					
					for (const g of geos) {
						if (!g.attributes || !g.attributes.position) continue;
						totalVertices += g.attributes.position.count;
						if (g.index) totalIndices += g.index.count;
					}

					if (totalVertices === 0) return merged;

					const positions = new Float32Array(totalVertices * 3);
					const indices = totalVertices > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);
					
					let vOffset = 0;
					let iOffset = 0;
					let mergeStartTime = performance.now();
					
					for (let k = 0; k < geos.length; k++) {
						const g = geos[k];
						if (!g.attributes || !g.attributes.position) continue;
						
						positions.set(g.attributes.position.array, vOffset * 3);
						
						if (g.index) {
							const indexArray = g.index.array;
							const indexCount = g.index.count;
							for (let i = 0; i < indexCount; i++) {
								indices[iOffset + i] = indexArray[i] + vOffset;
							}
							iOffset += indexCount;
						}
						
						vOffset += g.attributes.position.count;
						g.dispose();

						// Yield during merge to keep main thread alive
						if (performance.now() - mergeStartTime > 20) {
							reportProgress(`Merging layer geometries (${k}/${geos.length})...`, 90 + (k / geos.length) * 10);
							await new Promise(resolve => setTimeout(resolve, 0));
							mergeStartTime = performance.now();
						}
					}

					merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
					if (totalIndices > 0) merged.setIndex(new THREE.BufferAttribute(indices, 1));
					
					// Ensure bounding volumes are computed to avoid issues with near/far plane calculation
					merged.computeBoundingBox();
					merged.computeBoundingSphere();
					
					return merged;
				};

				const mergedFillGeom = await mergeGeometriesAsync(fillGeometries);
				
				// Create a single filled mesh for all polygons
				const fillMesh = new THREE.Mesh(mergedFillGeom, fillMaterial);
				fillMesh.renderOrder = 10;
				polygonGroup.add(fillMesh);

				// Create a single outline mesh for all polygons directly from positions array
				if (polygonOutlinePositions.length > 0) {
					const outGeom = new THREE.BufferGeometry();
					outGeom.setAttribute('position', new THREE.Float32BufferAttribute(polygonOutlinePositions, 3));
					outGeom.computeBoundingBox();
					outGeom.computeBoundingSphere();
					const outlineMesh = new THREE.LineSegments(outGeom, outlineMaterial);
					outlineMesh.renderOrder = 11;
					polygonGroup.add(outlineMesh);
				}
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

	async loadShapefileFeatures(file, reportProgress) {
		let features = [];
		
		// To prevent the shapefile library from incorrectly appending extensions 
		// to URLs with SAS tokens (e.g. ...sig=ABC -> ...sig=ABC.shp),
		// we manually fetch the buffers ourselves.
		let shpBuffer, dbfBuffer;

		const getProxiedUrl = (url) => {
			if (url && url.includes('.blob.core.windows.net')) {
				// Decode first to normalize any already-encoded chars (e.g. %2F in SAS tokens)
				// then re-encode cleanly — prevents double-encoding (%2F -> %252F) which
				// breaks SAS signature validation on Azure and causes 404s.
				return `/api/proxy-layer?url=${encodeURIComponent(decodeURIComponent(url))}`;
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
		let count = 0;
		let lastYieldTime = performance.now();
		while (true) {
			let result = await source.read();
			if (result.done) break;

			if (result.value && result.value.type === 'Feature' && result.value.geometry !== undefined) {
				features.push(result.value);
				count++;
				if (performance.now() - lastYieldTime > 20) {
					if (reportProgress) reportProgress(`Reading features (${count})...`, null);
					await new Promise(resolve => setTimeout(resolve, 0));
					lastYieldTime = performance.now();
				}
			}
		}
		return features;
	}

};
