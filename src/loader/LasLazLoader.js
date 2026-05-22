
/**
 * SRC/LOADER/LASLAOZLOADER.JS
 * 
 * LAS/LAZ Point Cloud Format Loader
 * 
 * STANDARDS:
 * - LAS: ASPRS LiDAR Data Interchange Format (uncompressed binary)
 * - LAZ: Compressed LAS using LASzip algorithm (requires decompression)
 * 
 * SUPPORTED VERSIONS:
 * - LAS 1.0 to 1.4 (1.4 required for extended attributes)
 * - LAZ: Full LAZ 1.x support via js-laslaz decompressor
 * 
 * FILE STRUCTURE:
 * ┌─────────────────────────────────────────────────┐
 * │ Header (227-375 bytes)                          │
 * │ - Signature, version, point count, bounds       │
 * ├─────────────────────────────────────────────────┤
 * │ Variable Records (optional)                     │
 * │ - Projection, SRS, classification schemas       │
 * ├─────────────────────────────────────────────────┤
 * │ Point Records (main data)                       │
 * │ - 20-149 bytes per point (format-dependent)     │
 * │ - Attributes: position, color, intensity,       │
 * │   classification, GPS time, scan angle, etc.    │
 * └─────────────────────────────────────────────────┘
 * 
 * PROCESSING PIPELINE:
 * 1. Fetch file from server (GET /path/to/file.las)
 * 2. LASFile.open() - Parse header, detect compression
 * 3. LASFile.readData() - Decompress point batches (if LAZ)
 * 4. LASDecoder (worker) - Parse point attributes in parallel
 * 5. Create THREE.BufferGeometry with attributes
 * 6. Store in GPU memory for rendering
 * 
 * PERFORMANCE OPTIMIZATION:
 * - Chunked reading: Process 1M points at a time
 * - Web Workers: Decode points in background threads (non-blocking)
 * - Streaming decompression: Don't load entire file into memory
 * - Skip points: Subsample for preview/LOD
 * 
 * CREDIT:
 * - Original js-laslaz by Uday Verma and Howard Butler
 * - Source: https://github.com/verma/plasio
 * - Used under Open Source license
 */

import * as THREE from "../../libs/three.js/build/three.module.js";
import {Version} from "../Version.js";
import {XHRFactory} from "../XHRFactory.js";

/**
 * LasLazLoader
 * 
 * Loads LAS and LAZ format point cloud files.
 * Handles both uncompressed (LAS) and compressed (LAZ) formats.
 */
export class LasLazLoader {

	/**
	 * Constructs a loader for a specific LAS version.
	 * 
	 * @param {string|Version} version - LAS version (e.g., "1.2", "1.4")
	 * @param {string} extension - File extension ("las" or "laz")
	 */
	constructor (version, extension) {
		if (typeof (version) === 'string') {
			this.version = new Version(version);
		} else {
			this.version = version;
		}

		this.extension = extension;
	}

	/**
	 * Global progress callback for all loads.
	 * Called with (progress: 0-1) as file is loaded/decompressed.
	 * Can be overridden: LasLazLoader.progressCB = (p) => console.log(p);
	 * 
	 * @type {Function}
	 */
	static progressCB () {

	}

	/**
	 * Download and parse a point cloud file.
	 * 
	 * FLOW:
	 * 1. Skip if already loaded
	 * 2. Build URL with proper extension (1.4+ requires explicit extension)
	 * 3. Fetch file via XHR as binary
	 * 4. Parse asynchronously
	 * 
	 * @param {PointCloudOctreeNode} node - Octree node to load (has pcoGeometry, parent tree)
	 */
	load (node) {
		if (node.loaded) {
			return;
		}

		let url = node.getURL();

		// LAS 1.4+ requires explicit file extension in URL
		if (this.version.equalOrHigher('1.4')) {
			url += `.${this.extension}`;
		}

		// Append query string if needed (e.g., ?cache-bust=123)
		if (node.pcoGeometry.queryString) {
			url += node.pcoGeometry.queryString;
		}

		// Fetch file as binary ArrayBuffer
		let xhr = XHRFactory.createXMLHttpRequest();
		xhr.open('GET', url, true);
		xhr.responseType = 'arraybuffer';
		xhr.overrideMimeType('text/plain; charset=x-user-defined');
		xhr.onreadystatechange = () => {
			if (xhr.readyState === 4) {
				if (xhr.status === 200 || xhr.status === 0) {
					let buffer = xhr.response;
					this.parse(node, buffer);
				} else {
					console.log('Failed to load file! HTTP status: ' + xhr.status + ', file: ' + url);
				}
			}
		};

		xhr.send(null);
	}

	/**
	 * Parse LAS/LAZ binary data.
	 * 
	 * ALGORITHM:
	 * 1. Create LASFile instance from buffer
	 * 2. Open file (decompress if LAZ)
	 * 3. Read header (point count, bounds, format)
	 * 4. Read point records in 1M point chunks
	 * 5. Decode each chunk with web worker
	 * 6. Report progress
	 * 7. Close file (cleanup)
	 * 
	 * @async
	 * @param {PointCloudOctreeNode} node - Target octree node
	 * @param {ArrayBuffer} buffer - File binary data
	 */
	async parse(node, buffer){
		let lf = new LASFile(buffer);
		let handler = new LasLazBatcher(node);

		try{
			 await lf.open();
			 lf.isOpen = true;
		}catch(e){
			console.log("failed to open file. :(");

			return;
		}

		let header = await lf.getHeader();

		let skip = 1;
		let totalRead = 0;
		let totalToRead = (skip <= 1 ? header.pointsCount : header.pointsCount / skip);

		let hasMoreData = true;

		// Process point records in batches (1M points at a time)
		while(hasMoreData){
			let data = await lf.readData(1000 * 1000, 0, skip);

			handler.push(new LASDecoder(data.buffer,
				header.pointsFormatId,
				header.pointsStructSize,
				data.count,
				header.scale,
				header.offset,
				header.mins, header.maxs));

			totalRead += data.count;
			LasLazLoader.progressCB(totalRead / totalToRead);

			hasMoreData = data.hasMoreData;
		}

		header.totalRead = totalRead;
		header.versionAsString = lf.versionAsString;
		header.isCompressed = lf.isCompressed;

		LasLazLoader.progressCB(1);

		try{
			await lf.close();

			lf.isOpen = false;
		}catch(e){
			console.error("failed to close las/laz file!!!");
			
			throw e;
		}
	}

	/**
	 * Handle loaded node (for custom post-processing).
	 * Currently unused; can be extended for custom behavior.
	 * 
	 * @param {PointCloudOctreeNode} node - Loaded node
	 * @param {string} url - Node URL
	 */
	handle (node, url) {

	}
};

/**
 * LasLazBatcher
 * 
 * Processes decoded point batches using web workers.
 * Converts LAS point data to THREE.BufferGeometry for rendering.
 */
export class LasLazBatcher{

	/**
	 * Creates a batcher for a specific octree node.
	 * 
	 * @param {PointCloudOctreeNode} node - Target octree node
	 */
	constructor (node) {
		this.node = node;
	}

	/**
	 * Process a batch of decoded points.
	 * 
	 * FLOW:
	 * 1. Get worker from pool (non-blocking decode)
	 * 2. Worker decodes point attributes (position, color, intensity, etc.)
	 * 3. Create THREE.BufferGeometry with decoded data
	 * 4. Set point cloud node's geometry and mark as loaded
	 * 5. Notify renderer of changes
	 * 
	 * @param {Object} lasBuffer - Decoded LAS buffer object
	 */
	push (lasBuffer) {
		const workerPath = Potree.scriptPath + '/workers/LASDecoderWorker.js';
		const worker = Potree.workerPool.getWorker(workerPath);
		const node = this.node;
		const pointAttributes = node.pcoGeometry.pointAttributes;

		worker.onmessage = (e) => {
			let geometry = new THREE.BufferGeometry();
			let numPoints = lasBuffer.pointsCount;

			// Extract decoded attributes from worker
			let positions = new Float32Array(e.data.position);
			let colors = new Uint8Array(e.data.color);
			let intensities = new Float32Array(e.data.intensity);
			let classifications = new Uint8Array(e.data.classification);
			let returnNumbers = new Uint8Array(e.data.returnNumber);
			let numberOfReturns = new Uint8Array(e.data.numberOfReturns);
			let pointSourceIDs = new Uint16Array(e.data.pointSourceID);
			let indices = new Uint8Array(e.data.indices);

			// Create GPU buffers for rendering
			geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
			geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4, true));
			geometry.setAttribute('intensity', new THREE.BufferAttribute(intensities, 1));
			geometry.setAttribute('classification', new THREE.BufferAttribute(classifications, 1));
			geometry.setAttribute('return number', new THREE.BufferAttribute(returnNumbers, 1));
			geometry.setAttribute('number of returns', new THREE.BufferAttribute(numberOfReturns, 1));
			geometry.setAttribute('source id', new THREE.BufferAttribute(pointSourceIDs, 1));
			geometry.setAttribute('indices', new THREE.BufferAttribute(indices, 4));
			geometry.attributes.indices.normalized = true;

			for(const key in e.data.ranges){
				const range = e.data.ranges[key];

				const attribute = pointAttributes.attributes.find(a => a.name === key);
				attribute.range[0] = Math.min(attribute.range[0], range[0]);
				attribute.range[1] = Math.max(attribute.range[1], range[1]);
			}

			let tightBoundingBox = new THREE.Box3(
				new THREE.Vector3().fromArray(e.data.tightBoundingBox.min),
				new THREE.Vector3().fromArray(e.data.tightBoundingBox.max)
			);

			geometry.boundingBox = this.node.boundingBox;
			this.node.tightBoundingBox = tightBoundingBox;

			this.node.geometry = geometry;
			this.node.numPoints = numPoints;
			this.node.loaded = true;
			this.node.loading = false;
			Potree.numNodesLoading--;
			this.node.mean = new THREE.Vector3(...e.data.mean);

			Potree.workerPool.returnWorker(workerPath, worker);
		};

		let message = {
			buffer: lasBuffer.arrayb,
			numPoints: lasBuffer.pointsCount,
			pointSize: lasBuffer.pointSize,
			pointFormatID: 2,
			scale: lasBuffer.scale,
			offset: lasBuffer.offset,
			mins: lasBuffer.mins,
			maxs: lasBuffer.maxs
		};
		worker.postMessage(message, [message.buffer]);
	};
}
