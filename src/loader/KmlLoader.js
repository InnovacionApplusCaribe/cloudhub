import * as THREE from "../../libs/three.js/build/three.module.js";
import { GisLayer } from "../utils/GisLayer.js";

// ━━━ Configuration Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const MAX_FEATURES = 20000;              // Hard limit on parsed features
const MAX_VERTICES_PER_RING = 5000;      // Simplification threshold per polygon ring
const GEOMETRY_CHUNK_SIZE = 200;         // Shapes processed per merge chunk
const PARSE_BATCH_SIZE = 500;            // Placemarks parsed per yield
const MEMORY_WARNING_THRESHOLD = 0.80;   // % of heap when simplification increases
const MEMORY_ABORT_THRESHOLD = 0.90;     // % of heap when processing stops
const OUTLINE_SKIP_THRESHOLD = 5000;     // Polygon count above which outlines are skipped

export class KmlLoader {

	constructor() {
		this.transform = null;
		this.offset = new THREE.Vector3(0, 0, 0);
		this.boundingBox = null;
		this.defaultZ = null;
	}

	// ━━━ Memory Pressure Detection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	_checkMemoryPressure() {
		// performance.memory is only available in Chromium-based browsers
		if (typeof performance !== 'undefined' && performance.memory) {
			const used = performance.memory.usedJSHeapSize;
			const limit = performance.memory.jsHeapSizeLimit;
			const ratio = used / limit;
			return { ratio, used, limit, available: true };
		}
		return { ratio: 0, used: 0, limit: 0, available: false };
	}

	// ━━━ Douglas-Peucker Ring Simplification ━━━━━━━━━━━━━━━━━━━━━
	_simplifyRing(coords, tolerance) {
		if (coords.length <= 4) return coords; // Minimum viable polygon (triangle + close)

		const sqDist = (p, a, b) => {
			const dx = b[0] - a[0];
			const dy = b[1] - a[1];
			const lenSq = dx * dx + dy * dy;
			if (lenSq === 0) {
				const ex = p[0] - a[0];
				const ey = p[1] - a[1];
				return ex * ex + ey * ey;
			}
			let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
			t = Math.max(0, Math.min(1, t));
			const projX = a[0] + t * dx;
			const projY = a[1] + t * dy;
			const ex = p[0] - projX;
			const ey = p[1] - projY;
			return ex * ex + ey * ey;
		};

		const toleranceSq = tolerance * tolerance;

		const simplify = (start, end, keep) => {
			let maxDist = 0;
			let maxIdx = start;
			for (let i = start + 1; i < end; i++) {
				const d = sqDist(coords[i], coords[start], coords[end]);
				if (d > maxDist) {
					maxDist = d;
					maxIdx = i;
				}
			}
			if (maxDist > toleranceSq) {
				keep[maxIdx] = true;
				if (maxIdx - start > 1) simplify(start, maxIdx, keep);
				if (end - maxIdx > 1) simplify(maxIdx, end, keep);
			}
		};

		const keep = new Array(coords.length).fill(false);
		keep[0] = true;
		keep[coords.length - 1] = true;
		simplify(0, coords.length - 1, keep);

		const result = [];
		for (let i = 0; i < coords.length; i++) {
			if (keep[i]) result.push(coords[i]);
		}

		// Ensure ring closure
		if (result.length >= 2) {
			const first = result[0];
			const last = result[result.length - 1];
			if (first[0] !== last[0] || first[1] !== last[1]) {
				result.push([...first]);
			}
		}

		// Must have at least 4 points for a valid polygon ring
		return result.length >= 4 ? result : coords;
	}

	_computeRingTolerance(ring) {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const coord of ring) {
			if (coord[0] < minX) minX = coord[0];
			if (coord[1] < minY) minY = coord[1];
			if (coord[0] > maxX) maxX = coord[0];
			if (coord[1] > maxY) maxY = coord[1];
		}
		const dx = maxX - minX;
		const dy = maxY - minY;
		const diagonal = Math.sqrt(dx * dx + dy * dy);
		return diagonal * 0.001; // 0.1% of extent diagonal
	}

	async load(path, color = 0x00BFFF, onProgress = null) {
		const reportProgress = (msg, percent) => {
			if (onProgress) onProgress(msg, percent);
		};

		reportProgress("Downloading KML file...", 0);
		const features = await this.loadKmlFeatures(path, reportProgress);
		const node = new GisLayer("KML Layer");
		node.color = color;
		const threeColor = new THREE.Color(color);

		let transform = this.transform;
		if (transform === null) {
			transform = { forward: (v) => v };
		}

		let needsProjection = false;
		let needsOffsetSubtraction = false;

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

			if (sampleCoords) {
				const [x, y, z] = sampleCoords;
				const ox = this.offset.x;
				const oy = this.offset.y;
				const oz = this.offset.z;

				// 1. Check if coordinates are already local (inside or very close to the local bounding box)
				let isLocal = false;
				if (this.boundingBox) {
					const localBox = this.boundingBox.clone().expandByScalar(Math.max(100, this.boundingBox.getSize(new THREE.Vector3()).length() * 0.2));
					const testZ = (z !== undefined && z !== null) ? z : localBox.getCenter(new THREE.Vector3()).z;
					if (localBox.containsPoint(new THREE.Vector3(x, y, testZ))) {
						isLocal = true;
					}
				} else {
					const offsetLen = this.offset.length();
					const coordLen = Math.sqrt(x*x + y*y);
					if (offsetLen > 10000 && coordLen < offsetLen * 0.1) {
						isLocal = true;
					}
				}

				if (isLocal) {
					console.log("[KmlLoader] Coordinates appear to be already local. Skipping projection and offset subtraction.");
					transform = { forward: (v) => v };
					needsProjection = false;
					needsOffsetSubtraction = false;
				} else {
					// 2. Check if WGS84 (long/lat)
					if (Math.abs(x) <= 180 && Math.abs(y) <= 90) {
						console.log("[KmlLoader] Coordinates appear to be WGS84 (longitude/latitude). Applying projection and offset subtraction.");
						needsProjection = true;
						needsOffsetSubtraction = true;
					} else {
						// 3. Otherwise, they must be raw UTM / Projected coordinates
						const distToLocal = Math.sqrt(x * x + y * y);
						const distToUtm = Math.sqrt((x - ox) * (x - ox) + (y - oy) * (y - oy));
						
						if (distToUtm < distToLocal) {
							console.log("[KmlLoader] Coordinates appear to be raw UTM/projected. Skipping projection but applying offset subtraction.");
							transform = { forward: (v) => v };
							needsProjection = false;
							needsOffsetSubtraction = true;
						} else {
							console.warn("[KmlLoader] Coordinates do not match WGS84, local bounds, or UTM offset. Defaulting to local (no transform).");
							transform = { forward: (v) => v };
							needsProjection = false;
							needsOffsetSubtraction = false;
						}
					}
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

		const activeOffset = needsOffsetSubtraction ? this.offset : new THREE.Vector3(0, 0, 0);

		const totalFeatures = features.length;
		let processedFeatures = 0;
		let lastYieldTime = performance.now();

		// ━━━ Memory pressure tracking for adaptive simplification ━━━
		let aggressiveSimplification = false;
		let memoryAborted = false;
		let totalVerticesProcessed = 0;

		for (const feature of features) {
			processedFeatures++;

			// ━━━ Memory check every 100 features ━━━
			if (processedFeatures % 100 === 0) {
				const mem = this._checkMemoryPressure();
				if (mem.available) {
					if (mem.ratio >= MEMORY_ABORT_THRESHOLD) {
						console.warn(`[KmlLoader] Memory abort threshold reached (${(mem.ratio * 100).toFixed(1)}%). Stopping at feature ${processedFeatures}/${totalFeatures}.`);
						reportProgress(`⚠️ Memory limit reached — loaded ${processedFeatures} of ${totalFeatures} features`, 100);
						memoryAborted = true;
						break;
					} else if (mem.ratio >= MEMORY_WARNING_THRESHOLD && !aggressiveSimplification) {
						console.warn(`[KmlLoader] Memory warning threshold reached (${(mem.ratio * 100).toFixed(1)}%). Increasing simplification.`);
						aggressiveSimplification = true;
					}
				}
			}
			
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
				const zInput = geometry.coordinates[2] !== undefined ? geometry.coordinates[2] : defaultZ;
				// transform.forward already includes CRS projection AND offset adjustment
				const p = transform.forward([long, lat, zInput]);

				// Explicitly subtract pointcloud offset to avoid Earcut/precision errors
				const x = p[0] - activeOffset.x;
				const y = p[1] - activeOffset.y;
				const z = (p[2] !== undefined ? p[2] : zInput) - activeOffset.z;

				geometry.coordinates = [x, y, z]; // Update for picking
				pointPositions.push(x, y, z);
				totalVerticesProcessed++;
			} else if (geometry.type === "LineString") {
				const coords = geometry.coordinates;
				for (let i = 0; i < coords.length; i++) {
					const zInput = coords[i][2] !== undefined ? coords[i][2] : defaultZ;
					// transform.forward already handles CRS projection and offset
					const p = transform.forward([coords[i][0], coords[i][1], zInput]);

					const x = p[0] - activeOffset.x;
					const y = p[1] - activeOffset.y;
					const z = (p[2] !== undefined ? p[2] : zInput) - activeOffset.z;

					coords[i] = [x, y, z]; // Update for picking

					if (i < coords.length - 1) {
						const nextZInput = coords[i + 1][2] !== undefined ? coords[i + 1][2] : defaultZ;
						const nextP = transform.forward([coords[i + 1][0], coords[i + 1][1], nextZInput]);

						const nextX = nextP[0] - activeOffset.x;
						const nextY = nextP[1] - activeOffset.y;
						const nextZ = (nextP[2] !== undefined ? nextP[2] : nextZInput) - activeOffset.z;

						if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(nextX) && !isNaN(nextY) && !isNaN(nextZ)) {
							linePositions.push(x, y, z);
							linePositions.push(nextX, nextY, nextZ);
						}
					}
					totalVerticesProcessed++;
				}
			} else if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
				// ━━━ Skip fills under extreme memory pressure ━━━
				const skipFills = aggressiveSimplification;

				const parsePolygon = (polygonCoords) => {
					if (!polygonCoords || polygonCoords.length === 0) return;

					let shape = skipFills ? null : new THREE.Shape();
					let shapeZ = defaultZ;  // Will store transformed Z coordinate
					let outerRing = polygonCoords[0];

					// ━━━ Simplify ring if it exceeds vertex threshold ━━━
					if (outerRing.length > MAX_VERTICES_PER_RING || aggressiveSimplification) {
						const tolerance = aggressiveSimplification
							? this._computeRingTolerance(outerRing) * 5  // 5x more aggressive
							: this._computeRingTolerance(outerRing);
						outerRing = this._simplifyRing(outerRing, tolerance);
						polygonCoords[0] = outerRing;
					}

					for (let i = 0; i < outerRing.length; i++) {
						const zInput = outerRing[i][2] !== undefined ? outerRing[i][2] : defaultZ;

						// transform.forward already handles all coordinate transformations
						const p = transform.forward([outerRing[i][0], outerRing[i][1], zInput]);

						const x = p[0] - activeOffset.x;
						const y = p[1] - activeOffset.y;
						const z = (p[2] !== undefined ? p[2] : zInput) - activeOffset.z;

						if (i === 0) {
							shapeZ = z;  // Store the first (transformed) Z value
						}

						outerRing[i] = [x, y, z]; // Update for picking

						if (shape) {
							if (i === 0) shape.moveTo(x, y);
							else shape.lineTo(x, y);
						}

						if (i > 0) {
							const prev = outerRing[i - 1];
							polygonOutlinePositions.push(prev[0], prev[1], prev[2]);
							polygonOutlinePositions.push(x, y, z);
						}
						totalVerticesProcessed++;
					}

					for (let r = 1; r < polygonCoords.length; r++) {
						let hole = skipFills ? null : new THREE.Path();
						let holeRing = polygonCoords[r];

						// ━━━ Simplify hole rings too ━━━
						if (holeRing.length > MAX_VERTICES_PER_RING || aggressiveSimplification) {
							const tolerance = aggressiveSimplification
								? this._computeRingTolerance(holeRing) * 5
								: this._computeRingTolerance(holeRing);
							holeRing = this._simplifyRing(holeRing, tolerance);
							polygonCoords[r] = holeRing;
						}

						for (let i = 0; i < holeRing.length; i++) {
							const zInput = holeRing[i][2] !== undefined ? holeRing[i][2] : defaultZ;
							const p = transform.forward([holeRing[i][0], holeRing[i][1], zInput]);

							const x = p[0] - activeOffset.x;
							const y = p[1] - activeOffset.y;
							const z = (p[2] !== undefined ? p[2] : zInput) - activeOffset.z;

							holeRing[i] = [x, y, z]; // Update for picking

							if (hole) {
								if (i === 0) hole.moveTo(x, y);
								else hole.lineTo(x, y);
							}

							if (i > 0) {
								const prev = holeRing[i - 1];
								polygonOutlinePositions.push(prev[0], prev[1], prev[2]);
								polygonOutlinePositions.push(x, y, z);
							}
							totalVerticesProcessed++;
						}
						if (shape && hole) shape.holes.push(hole);
					}

					if (shape) {
						// Store the transformed Z coordinate (already adjusted for offset)
						shape.zOffset = shapeZ;
						shapesArray.push(shape);
					}
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

		if (memoryAborted) {
			console.warn(`[KmlLoader] Partial load: ${processedFeatures} features, ${totalVerticesProcessed} vertices processed before memory abort.`);
		}

		console.log(`[KmlLoader] Processed ${processedFeatures} features, ${totalVerticesProcessed} total vertices, ${shapesArray.length} polygon shapes.`);

		// ━━━ ENHANCED VISUALIZATION ━━━

		// Create 3D Point Markers
		if (pointPositions.length > 0) {
			const pointGroup = new THREE.Group();
			pointGroup.name = "Point Markers";

			const sphereGeometry = new THREE.SphereGeometry(0.8, 12, 12);
			const pointMaterial = new THREE.MeshLambertMaterial({
				color: threeColor,
				depthTest: false,
				depthWrite: false
			});

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

		// Create Lines
		if (linePositions.length > 0) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));

			const material = new THREE.LineBasicMaterial({
				color: threeColor,
				linewidth: 3,
				depthTest: false,
				depthWrite: false,
				transparent: true,
				opacity: 0.95
			});

			const segments = new THREE.LineSegments(geometry, material);
			segments.renderOrder = 10;
			node.linesMesh = segments;
			node.add(segments);
		}

		// Create Polygons — ━━━ CHUNKED GEOMETRY BUILDING ━━━
		if (shapesArray.length > 0) {
			const polygonGroup = new THREE.Group();
			polygonGroup.name = "Polygons";

			const GeometryClass = THREE.ShapeGeometry;

			const fillMaterial = new THREE.MeshLambertMaterial({
				color: threeColor,
				opacity: 0.40,
				transparent: true,
				side: THREE.DoubleSide,
				depthTest: false,
				depthWrite: false,
				wireframe: false
			});

			const outlineMaterial = new THREE.LineBasicMaterial({
				color: threeColor,
				linewidth: 2,
				depthTest: false,
				depthWrite: false,
				transparent: true,
				opacity: 1.0
			});

			// ━━━ Process shapes in chunks to limit peak memory ━━━
			const chunkGeometries = [];
			const totalShapes = shapesArray.length;

			for (let chunkStart = 0; chunkStart < totalShapes; chunkStart += GEOMETRY_CHUNK_SIZE) {
				const chunkEnd = Math.min(chunkStart + GEOMETRY_CHUNK_SIZE, totalShapes);
				const chunkFillGeometries = [];

				for (let i = chunkStart; i < chunkEnd; i++) {
					const shape = shapesArray[i];
					let shapeGeom;
					try {
						shapeGeom = new GeometryClass(shape);
					} catch (e) {
						console.warn(`[KmlLoader] Failed to triangulate shape ${i}:`, e.message);
						continue;
					}
					const shapeZ = shape.zOffset !== undefined ? shape.zOffset : 0;

					if (shapeGeom.attributes && shapeGeom.attributes.position) {
						const posAttr = shapeGeom.attributes.position;
						for (let j = 0; j < posAttr.count; j++) {
							posAttr.setZ(j, shapeZ);
						}
					}

					chunkFillGeometries.push(shapeGeom);
				}

				// Merge this chunk into a single BufferGeometry
				if (chunkFillGeometries.length > 0) {
					const mergedChunk = this._mergeGeometries(chunkFillGeometries);
					chunkGeometries.push(mergedChunk);

					// Dispose individual geometries immediately to free memory
					for (const g of chunkFillGeometries) {
						g.dispose();
					}
				}

				// Yield to UI thread between chunks
				reportProgress(`Building meshes (${Math.min(chunkEnd, totalShapes)}/${totalShapes})...`, 50 + (chunkEnd / totalShapes) * 40);
				await new Promise(resolve => setTimeout(resolve, 0));
				lastYieldTime = performance.now();

				// ━━━ Memory check between chunks ━━━
				const mem = this._checkMemoryPressure();
				if (mem.available && mem.ratio >= MEMORY_ABORT_THRESHOLD) {
					console.warn(`[KmlLoader] Memory abort during geometry building. Processed ${chunkEnd}/${totalShapes} shapes.`);
					break;
				}
			}

			// Final merge of chunk geometries (far fewer, smaller geometries)
			if (chunkGeometries.length > 0) {
				reportProgress(`Final geometry merge...`, 90);
				await new Promise(resolve => setTimeout(resolve, 0));

				let mergedFillGeom;
				if (chunkGeometries.length === 1) {
					mergedFillGeom = chunkGeometries[0];
				} else {
					mergedFillGeom = this._mergeGeometries(chunkGeometries);
					// Dispose chunk geometries
					for (const g of chunkGeometries) {
						g.dispose();
					}
				}

				const fillMesh = new THREE.Mesh(mergedFillGeom, fillMaterial);
				fillMesh.renderOrder = 10;
				polygonGroup.add(fillMesh);

				// ━━━ Skip outlines for very large polygon counts ━━━
				if (polygonOutlinePositions.length > 0 && totalShapes <= OUTLINE_SKIP_THRESHOLD) {
					const outGeom = new THREE.BufferGeometry();
					outGeom.setAttribute('position', new THREE.Float32BufferAttribute(polygonOutlinePositions, 3));
					outGeom.computeBoundingBox();
					outGeom.computeBoundingSphere();
					const outlineMesh = new THREE.LineSegments(outGeom, outlineMaterial);
					outlineMesh.renderOrder = 11;
					polygonGroup.add(outlineMesh);
				} else if (totalShapes > OUTLINE_SKIP_THRESHOLD) {
					console.log(`[KmlLoader] Skipping outline rendering for ${totalShapes} polygons (threshold: ${OUTLINE_SKIP_THRESHOLD}).`);
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

	// ━━━ Synchronous geometry merge helper ━━━━━━━━━━━━━━━━━━━━━━━
	_mergeGeometries(geos) {
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
		
		for (const g of geos) {
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
		}

		merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		if (totalIndices > 0) merged.setIndex(new THREE.BufferAttribute(indices, 1));
		
		merged.computeBoundingBox();
		merged.computeBoundingSphere();
		
		return merged;
	}

	async loadKmlFeatures(file, reportProgress) {
		let kmlText;
		
		const getProxiedUrl = (url) => {
			if (url && url.includes('.blob.core.windows.net')) {
				return `/api/proxy-layer?url=${encodeURIComponent(decodeURIComponent(url))}`;
			}
			return url;
		};

		if (typeof file === 'string') {
			const res = await fetch(getProxiedUrl(file));
			if (!res.ok) throw new Error(`Failed to fetch KML: ${res.statusText}`);
			kmlText = await res.text();
		} else if (file instanceof Blob) {
			kmlText = await file.text();
		} else {
			throw new Error("Unsupported file source type.");
		}

		// ━━━ Large file warning ━━━
		const fileSizeMB = (kmlText.length / (1024 * 1024)).toFixed(1);
		if (kmlText.length > 5 * 1024 * 1024) {
			console.warn(`[KmlLoader] Large KML file detected: ${fileSizeMB} MB. Processing may take longer.`);
			if (reportProgress) reportProgress(`⚠️ Large KML file (${fileSizeMB} MB) — parsing...`, null);
		}

		const parser = new DOMParser();
		const doc = parser.parseFromString(kmlText, 'text/xml');
		
		// ━━━ Release kmlText immediately to free memory ━━━
		kmlText = null;

		const placemarks = doc.querySelectorAll('Placemark');
		
		// ━━━ Feature count limit check ━━━
		const totalPlacemarks = placemarks.length;
		if (totalPlacemarks > MAX_FEATURES) {
			console.warn(`[KmlLoader] KML contains ${totalPlacemarks} placemarks, exceeding limit of ${MAX_FEATURES}. Only the first ${MAX_FEATURES} will be processed.`);
			if (reportProgress) reportProgress(`⚠️ Large file: processing first ${MAX_FEATURES} of ${totalPlacemarks} features...`, null);
		}
		const maxToProcess = Math.min(totalPlacemarks, MAX_FEATURES);

		const features = [];
		let count = 0;
		let lastYieldTime = performance.now();

		const parseCoordinatesString = (coordsStr) => {
			const coords = [];
			const points = coordsStr.trim().split(/\s+/);
			for (const p of points) {
				if (!p) continue;
				const parts = p.split(',').map(Number);
				if (parts.length >= 2) {
					const lon = parts[0];
					const lat = parts[1];
					const alt = parts[2] !== undefined ? parts[2] : 0;
					coords.push([lon, lat, alt]);
				}
			}
			return coords;
		};

		// ━━━ Process placemarks in batches ━━━
		for (let pmIdx = 0; pmIdx < maxToProcess; pmIdx++) {
			const pm = placemarks[pmIdx];
			const nameEl = pm.querySelector('name');
			const name = (nameEl && nameEl.textContent) ? nameEl.textContent.trim() : 'Unnamed';
			const descEl = pm.querySelector('description');
			const desc = (descEl && descEl.textContent) ? descEl.textContent.trim() : '';
			const properties = { name, description: desc };

			const dataEls = pm.querySelectorAll('ExtendedData Data, ExtendedData SimpleData');
			for (const dataEl of dataEls) {
				const nameAttr = dataEl.getAttribute('name');
				const valEl = dataEl.querySelector('value');
				const value = valEl ? valEl.textContent.trim() : dataEl.textContent.trim();
				if (nameAttr) properties[nameAttr] = value;
			}

			const geometries = [];

			// Parse Points
			pm.querySelectorAll('Point').forEach(el => {
				const coordsEl = el.querySelector('coordinates');
				if (coordsEl) {
					const coords = parseCoordinatesString(coordsEl.textContent);
					if (coords.length > 0) {
						geometries.push({ type: 'Point', coordinates: coords[0] });
					}
				}
			});

			// Parse LineStrings
			pm.querySelectorAll('LineString').forEach(el => {
				const coordsEl = el.querySelector('coordinates');
				if (coordsEl) {
					const coords = parseCoordinatesString(coordsEl.textContent);
					if (coords.length > 0) {
						geometries.push({ type: 'LineString', coordinates: coords });
					}
				}
			});

			// Parse Polygons
			pm.querySelectorAll('Polygon').forEach(el => {
				const coordinates = [];
				const outerRingEl = el.querySelector('outerBoundaryIs LinearRing coordinates');
				if (outerRingEl) {
					coordinates.push(parseCoordinatesString(outerRingEl.textContent));
				}
				const innerRingEls = el.querySelectorAll('innerBoundaryIs LinearRing coordinates');
				innerRingEls.forEach(innerRingEl => {
					coordinates.push(parseCoordinatesString(innerRingEl.textContent));
				});
				if (coordinates.length > 0) {
					geometries.push({ type: 'Polygon', coordinates: coordinates });
				}
			});

			for (const geom of geometries) {
				features.push({
					type: 'Feature',
					geometry: geom,
					properties: properties
				});
			}

			count++;

			// ━━━ Yield every PARSE_BATCH_SIZE placemarks ━━━
			if (count % PARSE_BATCH_SIZE === 0 || performance.now() - lastYieldTime > 20) {
				if (reportProgress) reportProgress(`Parsing KML features (${count}/${maxToProcess})...`, null);
				await new Promise(resolve => setTimeout(resolve, 0));
				lastYieldTime = performance.now();
			}
		}

		// ━━━ Release DOM document to free memory ━━━
		// The doc variable will be garbage collected when it goes out of scope,
		// but we explicitly null it for clarity
		// (doc is const so we can't reassign, but it goes out of scope here)

		return features;
	}

}
