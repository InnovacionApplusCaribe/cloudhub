import * as THREE from "../../libs/three.js/build/three.module.js";
import { GisLayer } from "../utils/GisLayer.js";

export class KmlLoader {

	constructor() {
		this.transform = null;
		this.offset = new THREE.Vector3(0, 0, 0);
		this.boundingBox = null;
		this.defaultZ = null;
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
				const zInput = geometry.coordinates[2] !== undefined ? geometry.coordinates[2] : defaultZ;
				// transform.forward already includes CRS projection AND offset adjustment
				const p = transform.forward([long, lat, zInput]);

				// Explicitly subtract pointcloud offset to avoid Earcut/precision errors
				const x = p[0] - activeOffset.x;
				const y = p[1] - activeOffset.y;
				const z = (p[2] !== undefined ? p[2] : zInput) - activeOffset.z;

				geometry.coordinates = [x, y, z]; // Update for picking
				pointPositions.push(x, y, z);
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

						const x = p[0] - activeOffset.x;
						const y = p[1] - activeOffset.y;
						const z = (p[2] !== undefined ? p[2] : zInput) - activeOffset.z;

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

							const x = p[0] - activeOffset.x;
							const y = p[1] - activeOffset.y;
							const z = (p[2] !== undefined ? p[2] : zInput) - activeOffset.z;

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

		// Create Polygons
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

			const fillGeometries = [];
			
			for (let i = 0; i < shapesArray.length; i++) {
				const shape = shapesArray[i];
				const geometry = new GeometryClass(shape);
				const shapeZ = shape.zOffset !== undefined ? shape.zOffset : 0;

				if (geometry.attributes && geometry.attributes.position) {
					const posAttr = geometry.attributes.position;
					for (let j = 0; j < posAttr.count; j++) {
						posAttr.setZ(j, shapeZ);
					}
				}

				fillGeometries.push(geometry);

				if (performance.now() - lastYieldTime > 30) {
					reportProgress(`Building meshes (${i}/${shapesArray.length})...`, 50 + (i / shapesArray.length) * 50);
					await new Promise(resolve => setTimeout(resolve, 0));
					lastYieldTime = performance.now();
				}
			}

			if (fillGeometries.length > 0) {
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

						if (performance.now() - mergeStartTime > 20) {
							reportProgress(`Merging layer geometries (${k}/${geos.length})...`, 90 + (k / geos.length) * 10);
							await new Promise(resolve => setTimeout(resolve, 0));
							mergeStartTime = performance.now();
						}
					}

					merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
					if (totalIndices > 0) merged.setIndex(new THREE.BufferAttribute(indices, 1));
					
					merged.computeBoundingBox();
					merged.computeBoundingSphere();
					
					return merged;
				};

				const mergedFillGeom = await mergeGeometriesAsync(fillGeometries);
				const fillMesh = new THREE.Mesh(mergedFillGeom, fillMaterial);
				fillMesh.renderOrder = 10;
				polygonGroup.add(fillMesh);

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

		const parser = new DOMParser();
		const doc = parser.parseFromString(kmlText, 'text/xml');
		const placemarks = doc.querySelectorAll('Placemark');
		
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

		for (const pm of placemarks) {
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
			if (performance.now() - lastYieldTime > 20) {
				if (reportProgress) reportProgress(`Parsing KML features (${count}/${placemarks.length})...`, null);
				await new Promise(resolve => setTimeout(resolve, 0));
				lastYieldTime = performance.now();
			}
		}

		return features;
	}

}
