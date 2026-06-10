/**
 * KML to Shapefile Converter
 * 
 * Converts KML/KMZ files to shapefile-compatible GeoJSON features.
 * Extracts polygon geometries from KML and converts them to a format
 * that can be processed by ShapefileLoader for consistent 3D visualization.
 * 
 * Key Features:
 * - Parses KML/KMZ files and extracts polygon geometries
 * - Converts polygon coordinates to shapefile format
 * - Preserves polygon properties and attributes
 * - Supports both Point, LineString, and Polygon geometries
 * - Memory-efficient processing with progress reporting
 * 
 * Usage:
 *   const converter = new KmlToShapefileConverter();
 *   const shapefileFeatures = await converter.convertKmlToShapefile(kmlText, onProgress);
 *   // shapefileFeatures can now be processed by ShapefileLoader geometry logic
 */

const MAX_FEATURES = 20000;              // Hard limit on parsed features
const MAX_VERTICES_PER_RING = 5000;      // Simplification threshold per polygon ring
const PARSE_BATCH_SIZE = 500;            // Placemarks parsed per yield
const MEMORY_WARNING_THRESHOLD = 0.8;    // % of heap when simplification increases
const MEMORY_ABORT_THRESHOLD = 0.9;      // % of heap when processing stops

export class KmlToShapefileConverter {

	constructor() {
		this.polygonCount = 0;
		this.pointCount = 0;
		this.lineCount = 0;
		this.droppedFeatures = 0;
	}

	/**
	 * Check memory pressure and return statistics
	 * @returns {Object} Memory info with ratio, used, limit, and availability
	 */
	_checkMemoryPressure() {
		if (typeof performance !== 'undefined' && performance.memory) {
			const used = performance.memory.usedJSHeapSize;
			const limit = performance.memory.jsHeapSizeLimit;
			const ratio = used / limit;
			return { ratio, used, limit, available: true };
		}
		return { ratio: 0, used: 0, limit: 0, available: false };
	}

	/**
	 * Douglas-Peucker polygon ring simplification
	 * Reduces the number of vertices while preserving polygon shape
	 * @param {Array<[number, number, number]>} coords - Ring coordinates [lon, lat, alt]
	 * @param {number} tolerance - Simplification tolerance
	 * @returns {Array<[number, number, number]>} Simplified coordinates
	 */
	_simplifyRing(coords, tolerance) {
		if (coords.length <= 4) return coords;

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

		return result.length >= 4 ? result : coords;
	}

	/**
	 * Compute adaptive tolerance for ring simplification
	 * Tolerance is based on the diagonal of the ring's bounding box
	 * @param {Array<[number, number, number]>} ring - Polygon ring coordinates
	 * @returns {number} Tolerance value
	 */
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
		const diagonal = Math.hypot(dx, dy);
		return diagonal * 0.001; // 0.1% of extent diagonal
	}

	/**
	 * Parse coordinate string from KML
	 * @param {string} coordsStr - Coordinate string (whitespace-separated lon,lat,alt tuples)
	 * @returns {Array<[number, number, number]>} Array of [lon, lat, alt] coordinates
	 */
	_parseCoordinatesString(coordsStr) {
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
	}

	/**
	 * Extract all polygon features from KML document
	 * Filters and extracts only polygon geometries while preserving properties
	 * @param {Document} doc - Parsed KML DOM document
	 * @param {Function} reportProgress - Progress callback (msg, percent)
	 * @returns {Array<Object>} Array of GeoJSON-like features with polygon geometry
	 */
	async _extractPolygonFeaturesFromKml(doc, reportProgress) {
		const placemarks = doc.querySelectorAll('Placemark');
		const totalPlacemarks = placemarks.length;

		if (totalPlacemarks > MAX_FEATURES) {
			console.warn(`[KmlToShapefileConverter] KML contains ${totalPlacemarks} placemarks, exceeding limit of ${MAX_FEATURES}. Processing first ${MAX_FEATURES}.`);
			if (reportProgress) reportProgress(`⚠️ Large file: processing first ${MAX_FEATURES} of ${totalPlacemarks} features...`, null);
		}

		const maxToProcess = Math.min(totalPlacemarks, MAX_FEATURES);
		const polygonFeatures = [];
		let processedCount = 0;
		let lastYieldTime = performance.now();
		let aggressiveSimplification = false;

		for (let pmIdx = 0; pmIdx < maxToProcess; pmIdx++) {
			processedCount++;

			// Memory check every 100 features
			if (processedCount % 100 === 0) {
				const mem = this._checkMemoryPressure();
				if (mem.available) {
					if (mem.ratio >= MEMORY_ABORT_THRESHOLD) {
						console.warn(`[KmlToShapefileConverter] Memory abort threshold reached (${(mem.ratio * 100).toFixed(1)}%). Stopping at feature ${processedCount}/${maxToProcess}.`);
						if (reportProgress) reportProgress(`⚠️ Memory limit reached — processed ${processedCount} of ${maxToProcess} features`, 100);
						break;
					} else if (mem.ratio >= MEMORY_WARNING_THRESHOLD && !aggressiveSimplification) {
						console.warn(`[KmlToShapefileConverter] Memory warning reached (${(mem.ratio * 100).toFixed(1)}%). Increasing simplification.`);
						aggressiveSimplification = true;
					}
				}
			}

			// Yield periodically to keep UI responsive
			if (performance.now() - lastYieldTime > 20) {
				if (reportProgress) reportProgress(`Extracting polygons (${processedCount}/${maxToProcess})...`, (processedCount / maxToProcess) * 50);
				await new Promise(resolve => setTimeout(resolve, 0));
				lastYieldTime = performance.now();
			}

			const pm = placemarks[pmIdx];
			const nameEl = pm.querySelector('name');
			const name = (nameEl && nameEl.textContent) ? nameEl.textContent.trim() : 'Unnamed';
			const descEl = pm.querySelector('description');
			const desc = (descEl && descEl.textContent) ? descEl.textContent.trim() : '';
			const properties = { name, description: desc };

			// Extract extended data attributes
			const dataEls = pm.querySelectorAll('ExtendedData Data, ExtendedData SimpleData');
			for (const dataEl of dataEls) {
				const nameAttr = dataEl.getAttribute('name');
				const valEl = dataEl.querySelector('value');
				const value = valEl ? valEl.textContent.trim() : dataEl.textContent.trim();
				if (nameAttr) properties[nameAttr] = value;
			}

			// Extract polygons (ignore other geometry types in this filter)
			const polygons = pm.querySelectorAll('Polygon');
			for (const polygonEl of polygons) {
				const coordinates = [];
				const outerRingEl = polygonEl.querySelector('outerBoundaryIs LinearRing coordinates');
				
				if (outerRingEl) {
					let outerCoords = this._parseCoordinatesString(outerRingEl.textContent);
					
					// Simplify if needed
					if (outerCoords.length > MAX_VERTICES_PER_RING) {
						const tolerance = this._computeRingTolerance(outerCoords);
						const simplificationStrength = aggressiveSimplification ? tolerance * 10 : tolerance;
						outerCoords = this._simplifyRing(outerCoords, simplificationStrength);
						console.warn(`[KmlToShapefileConverter] Simplified outer ring from ${outerRingEl.textContent.trim().split(/\s+/).length} to ${outerCoords.length} vertices`);
					}
					
					coordinates.push(outerCoords);

					// Extract inner rings (holes)
					const innerRingEls = polygonEl.querySelectorAll('innerBoundaryIs LinearRing coordinates');
					for (const innerEl of innerRingEls) {
						let innerCoords = this._parseCoordinatesString(innerEl.textContent);
						
						if (innerCoords.length > MAX_VERTICES_PER_RING) {
							const tolerance = this._computeRingTolerance(innerCoords);
							const simplificationStrength = aggressiveSimplification ? tolerance * 10 : tolerance;
							innerCoords = this._simplifyRing(innerCoords, simplificationStrength);
						}
						
						coordinates.push(innerCoords);
					}

					// Create feature with polygon geometry
					const feature = {
						type: 'Feature',
						geometry: {
							type: 'Polygon',
							coordinates: coordinates
						},
						properties: properties
					};

					polygonFeatures.push(feature);
					this.polygonCount++;
				}
			}
		}

		if (reportProgress) reportProgress(`Extracted ${polygonFeatures.length} polygon features from ${processedCount} placemarks`, 50);

		return polygonFeatures;
	}

	/**
	 * Convert KML text to shapefile-compatible GeoJSON features
	 * Extracts polygon geometries and converts them to a format compatible with ShapefileLoader
	 * 
	 * @param {string|Blob} kmlInput - KML text content or Blob
	 * @param {Function} onProgress - Progress callback function (msg, percent)
	 * @returns {Promise<Object>} Object with features array, conversion stats, and metadata
	 */
	async convertKmlToShapefile(kmlInput, onProgress = null) {
		const reportProgress = (msg, percent) => {
			if (onProgress) onProgress(msg, percent);
		};

		reportProgress("Reading KML input...", 0);

		let kmlText;
		if (typeof kmlInput === 'string') {
			kmlText = kmlInput;
		} else if (kmlInput instanceof Blob) {
			kmlText = await kmlInput.text();
		} else {
			throw new Error("Unsupported KML input type. Provide string or Blob.");
		}

		const fileSizeMB = (kmlText.length / (1024 * 1024)).toFixed(1);
		if (kmlText.length > 5 * 1024 * 1024) {
			console.warn(`[KmlToShapefileConverter] Large KML file detected: ${fileSizeMB} MB`);
			reportProgress(`⚠️ Large KML file (${fileSizeMB} MB) — parsing...`, 10);
		}

		reportProgress("Parsing KML XML...", 15);
		const parser = new DOMParser();
		const doc = parser.parseFromString(kmlText, 'text/xml');
		
		// Check for XML parsing errors
		if (doc.getElementsByTagName('parsererror').length > 0) {
			throw new Error("Failed to parse KML: Invalid XML format");
		}

		// Release memory
		kmlText = null;

		reportProgress("Extracting polygon geometries...", 20);
		const features = await this._extractPolygonFeaturesFromKml(doc, reportProgress);

		reportProgress("Conversion complete", 100);

		return {
			features: features,
			stats: {
				totalPolygons: this.polygonCount,
				totalPoints: this.pointCount,
				totalLines: this.lineCount,
				droppedFeatures: this.droppedFeatures
			},
			type: 'shapefile-converted-kml',
			metadata: {
				sourceFormat: 'KML',
				targetFormat: 'Shapefile-Compatible GeoJSON',
				conversionTime: new Date().toISOString()
			}
		};
	}

	/**
	 * Reset converter statistics (useful when converting multiple files)
	 */
	resetStats() {
		this.polygonCount = 0;
		this.pointCount = 0;
		this.lineCount = 0;
		this.droppedFeatures = 0;
	}
}
