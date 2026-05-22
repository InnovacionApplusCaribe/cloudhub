
/**
 * PointCloudOctree.js
 * 
 * CORE MODULE: Implements hierarchical octree-based point cloud representation with Level-of-Detail (LOD).
 * 
 * ARCHITECTURE:
 * - PointCloudOctree: Root container managing the entire point cloud hierarchy
 * - PointCloudOctreeNode: Individual octree nodes representing spatial subdivisions
 * - PointCloudOctreeGeometryNode: GPU-resident geometry for a node
 * 
 * KEY CONCEPTS:
 * 1. OCTREE STRUCTURE: 3D space subdivided into 8 child nodes (oct-tree)
 *    - Each level doubles resolution (2^level nodes at depth)
 *    - Efficient culling and LOD management
 * 
 * 2. LEVEL-OF-DETAIL (LOD):
 *    - Remote nodes (far from camera) load lower resolution versions
 *    - Closer nodes load progressively higher detail
 *    - Minimizes GPU memory and bandwidth usage
 * 
 * 3. VISIBILITY CULLING:
 *    - Camera frustum culling removes off-screen nodes
 *    - Pixel size heuristic: nodes smaller than minimumNodePixelSize are skipped
 *    - Dynamic point budget limits max visible points (performance cap)
 * 
 * 4. MATERIAL SYSTEM:
 *    - Single PointCloudMaterial shared across all nodes
 *    - Supports multiple rendering modes: RGB, Intensity, Classification, Elevation
 *    - Each node can have different attributes via material uniforms
 * 
 * USAGE EXAMPLE:
 *   const geometry = await loader.load('pointcloud.las');
 *   const material = new PointCloudMaterial({ vertexColors: true });
 *   const pointcloud = new PointCloudOctree(geometry, material);
 *   scene.add(pointcloud);
 *   // Renderer automatically manages LOD and visibility
 * 
 * PERFORMANCE NOTES:
 * - visiblePointsTarget: Aim for 2-4M visible points for smooth 60fps
 * - minimumNodePixelSize: Increase for performance, decrease for detail
 * - pointBudget: Hard limit on total points in memory
 */

import * as THREE from "../libs/three.js/build/three.module.js";
import {PointCloudTree, PointCloudTreeNode} from "./PointCloudTree.js";
import {PointCloudOctreeGeometryNode} from "./PointCloudOctreeGeometry.js";
import {Utils} from "./utils.js";
import {PointCloudMaterial} from "./materials/PointCloudMaterial.js";

/**
 * PointCloudOctreeNode
 * 
 * Represents a single node in the octree hierarchy.
 * Each node can have up to 8 children and contains a reference to a PointCloudOctreeGeometryNode
 * (which holds the actual point data on GPU).
 */
export class PointCloudOctreeNode extends PointCloudTreeNode {
	/**
	 * @constructor
	 */
	constructor () {
		super();

		/** @type {Array<PointCloudOctreeNode>} - Array of 8 possible child nodes */
		this.children = [];
		
		/** @type {THREE.Points} - Three.js object representing this node in 3D space */
		this.sceneNode = null;
		
		/** @type {PointCloudOctree} - Reference to parent octree */
		this.octree = null;
	}

	/**
	 * Returns the number of points in this node's geometry.
	 * @returns {number} Point count
	 */
	getNumPoints () {
		return this.geometryNode.numPoints;
	}

	/**
	 * Indicates this node is fully loaded (octree nodes are always loaded).
	 * @returns {boolean} Always true for octree nodes
	 */
	isLoaded () {
		return true;
	}

	/**
	 * Identifies this as a tree node (not a geometry node).
	 * @returns {boolean} Always true
	 */
	isTreeNode () {
		return true;
	}

	/**
	 * Identifies this is not a geometry-only node.
	 * @returns {boolean} Always false
	 */
	isGeometryNode () {
		return false;
	}

	/**
	 * Gets the depth level of this node in the octree.
	 * @returns {number} Level (0 = root)
	 */
	getLevel () {
		return this.geometryNode.level;
	}

	/**
	 * Gets the bounding sphere of this node.
	 * @returns {THREE.Sphere} Bounding sphere
	 */
	getBoundingSphere () {
		return this.geometryNode.boundingSphere;
	}

	/**
	 * Gets the axis-aligned bounding box of this node.
	 * @returns {THREE.Box3} Bounding box
	 */
	getBoundingBox () {
		return this.geometryNode.boundingBox;
	}

	/**
	 * Returns all 8 child nodes that exist.
	 * @returns {Array<PointCloudOctreeNode>} Non-null children
	 */
	getChildren () {
		let children = [];

		for (let i = 0; i < 8; i++) {
			if (this.children[i]) {
				children.push(this.children[i]);
			}
		}

		return children;
	}

	/**
	 * Finds all points within a box-shaped clipping volume.
	 * 
	 * ALGORITHM:
	 * 1. Convert each point from world space to box local space
	 * 2. Check if point is within [-0.5, 0.5] in all axes (box is unit cube in local space)
	 * 3. Convert passing points back to world space
	 * 
	 * @param {THREE.Mesh} boxNode - Box object whose matrix defines the clipping region
	 * @returns {Array<THREE.Vector3>} Points inside the box, or null if no geometry
	 */
	getPointsInBox(boxNode){

		if(!this.sceneNode){
			return null;
		}

		let buffer = this.geometryNode.buffer;

		let posOffset = buffer.offset("position");
		let stride = buffer.stride;
		let view = new DataView(buffer.data);

		// Convert from world space to box local space
		let worldToBox = boxNode.matrixWorld.clone().invert();
		let objectToBox = new THREE.Matrix4().multiplyMatrices(worldToBox, this.sceneNode.matrixWorld);

		let inBox = [];

		let pos = new THREE.Vector4();
		for(let i = 0; i < buffer.numElements; i++){
			// Read position from buffer (stride-based layout)
			let x = view.getFloat32(i * stride + posOffset + 0, true);
			let y = view.getFloat32(i * stride + posOffset + 4, true);
			let z = view.getFloat32(i * stride + posOffset + 8, true);

			// Transform to box local space
			pos.set(x, y, z, 1);
			pos.applyMatrix4(objectToBox);

			// Check if point is within unit cube
			if(-0.5 < pos.x && pos.x < 0.5){
				if(-0.5 < pos.y && pos.y < 0.5){
					if(-0.5 < pos.z && pos.z < 0.5){
						// Transform back to world space and store
						pos.set(x, y, z, 1).applyMatrix4(this.sceneNode.matrixWorld);
						inBox.push(new THREE.Vector3(pos.x, pos.y, pos.z));
					}
				}
			}
		}

		return inBox;
	}

	/**
	 * Gets the octree node name (e.g., "r", "r0", "r01").
	 * @type {string}
	 */
	get name () {
		return this.geometryNode.name;
	}
};

/**
 * PointCloudOctree
 * 
 * Main container for a point cloud with hierarchical octree structure.
 * Manages LOD, visibility culling, material uniforms, and node loading/unloading.
 * 
 * PROPERTIES:
 * - visiblePointsTarget: Desired number of visible points (~2M for 60fps)
 * - minimumNodePixelSize: Don't render nodes smaller than this (pixels)
 * - pointBudget: Hard limit on GPU memory (points)
 * - material: Shared PointCloudMaterial for all nodes
 * 
 * RENDERING PIPELINE:
 * 1. PotreeRenderer determines visible nodes based on frustum culling
 * 2. Visibility system loads high-LOD nodes, unloads distant ones
 * 3. Material is updated with camera/renderer uniforms each frame
 * 4. Three.js renders visible nodes via sceneNode objects
 */
export class PointCloudOctree extends PointCloudTree {
	/**
	 * Constructs a point cloud octree from geometry.
	 * 
	 * INITIALIZATION STEPS:
	 * 1. Copy geometry properties (bounds, offset)
	 * 2. Initialize material with best available attribute (RGBA > RGB > Intensity)
	 * 3. Set height min/max for elevation gradient rendering
	 * 4. Create root node from geometry
	 * 
	 * @param {PointCloudOctreeGeometry} geometry - Loaded octree geometry (has root node, attributes)
	 * @param {PointCloudMaterial} [material] - Custom material (optional, defaults to PointCloudMaterial)
	 */
	constructor (geometry, material) {
		super();

		/** @type {number} - Hard maximum points in memory */
		this.pointBudget = Infinity;
		
		/** @type {PointCloudOctreeGeometry} - Underlying geometry with octree structure */
		this.pcoGeometry = geometry;
		
		/** @type {THREE.Box3} - World-space bounding box */
		this.boundingBox = this.pcoGeometry.boundingBox;
		
		/** @type {THREE.Sphere} - World-space bounding sphere */
		this.boundingSphere = this.boundingBox.getBoundingSphere(new THREE.Sphere());
		
		/** @type {PointCloudMaterial} - Shared GPU material for all nodes */
		this.material = material || new PointCloudMaterial();
		
		/** @type {number} - Target visible point count (2M typical for 60fps) */
		this.visiblePointsTarget = 2 * 1000 * 1000;
		
		/** @type {number} - Don't render nodes with pixel size < this (skip small nodes) */
		this.minimumNodePixelSize = 150;
		
		/** @type {number} - Current tree level (0 = root) */
		this.level = 0;
		
		// Copy offset from geometry (geospatial coordinate system)
		this.position.copy(geometry.offset);
		this.updateMatrix();

		// Select best available rendering attribute
		{
			// Priority: RGBA > RGB > Intensity > Classification
			let priorityQueue = ["rgba", "rgb", "intensity", "classification"];
			let selected = "rgba";

			for(let attributeName of priorityQueue){
				let attribute = this.pcoGeometry.pointAttributes.attributes.find(a => a.name === attributeName);

				if(!attribute){
					continue;
				}

				// Check if attribute has meaningful range (not flat)
				let min = attribute.range[0].constructor.name === "Array" ? attribute.range[0] : [attribute.range[0]];
				let max = attribute.range[1].constructor.name === "Array" ? attribute.range[1] : [attribute.range[1]];

				let range_min = new THREE.Vector3(...min);
				let range_max = new THREE.Vector3(...max);
				let range = range_min.distanceTo(range_max);

				if(range === 0){
					continue;
				}

				selected = attributeName;
				break;
			}

			this.material.activeAttributeName = selected;
		}

		/** @type {boolean} - Debug: show bounding boxes */
		this.showBoundingBox = false;
		
		/** @type {Array<PointCloudOctreeNode>} - Debug: bounding box visuals */
		this.boundingBoxNodes = [];
		
		/** @type {Array} - Queue of nodes waiting to be loaded */
		this.loadQueue = [];
		
		/** @type {THREE.Box3} - Bounding box of visible nodes (updated each frame) */
		this.visibleBounds = new THREE.Box3();
		
		/** @type {Array<PointCloudOctreeNode>} - Currently visible nodes */
		this.visibleNodes = [];
		
		/** @type {Array} - Visible geometry for rendering */
		this.visibleGeometry = [];
		
		/** @type {boolean} - Generate DEM (digital elevation model) */
		this.generateDEM = false;
		
		/** @type {Array} - Profile requests pending processing */
		this.profileRequests = [];
		
		/** @type {string} - User-friendly name */
		this.name = '';
		
		/** @type {boolean} - Visibility toggle */
		this._visible = true;

		// Set material elevation gradient range from data bounds
		{
			let box = [this.pcoGeometry.tightBoundingBox, this.getBoundingBoxWorld()]
				.find(v => v !== undefined);

			this.updateMatrixWorld(true);
			box = Utils.computeTransformedBoundingBox(box, this.matrixWorld);

			let bMin = box.min.z;
			let bMax = box.max.z;
			this.material.heightMin = bMin;
			this.material.heightMax = bMax;
		}

		// Coordinate system projection (e.g., UTM zone)
		this.projection = geometry.projection;
		this.fallbackProjection = geometry.fallbackProjection;

		// Create root node from geometry
		this.root = this.pcoGeometry.root;
	}

	/**
	 * Sets the user-friendly name of this point cloud.
	 * Dispatches a 'name_changed' event if the name actually changes.
	 * 
	 * @param {string} name - New name for the point cloud
	 */
	setName (name) {
		if (this.name !== name) {
			this.name = name;
			this.dispatchEvent({type: 'name_changed', name: name, pointcloud: this});
		}
	}

	/**
	 * Gets the user-friendly name of this point cloud.
	 * @returns {string} Point cloud name
	 */
	getName () {
		return this.name;
	}

	/**
	 * Retrieves a point attribute by name (e.g., "intensity", "classification", "gpsTime").
	 * 
	 * @param {string} name - Attribute name
	 * @returns {Object|null} Attribute object with {name, range, [array]} or null if not found
	 */
	getAttribute(name){

		const attribute = this.pcoGeometry.pointAttributes.attributes.find(a => a.name === name);

		if(attribute){
			return attribute;
		}else{
			return null;
		}
	}

	/**
	 * Gets all available attributes for this point cloud.
	 * @returns {PointAttributes} Object with list of available attributes and their ranges
	 */
	getAttributes(){
		return this.pcoGeometry.pointAttributes;
	}

	/**
	 * Converts a geometry node to a scene tree node for rendering.
	 * 
	 * PROCESS:
	 * 1. Create PointCloudOctreeNode wrapper
	 * 2. Create THREE.Points object with geometry and material
	 * 3. Set up onBeforeRender callback to update material uniforms:
	 *    - level: Octree level for visual debugging
	 *    - vnStart: Visibility texture offset for this node
	 *    - pcIndex: Index in visible nodes array
	 * 4. Link to parent in scene graph or add as root
	 * 5. Set up dispose listener for memory cleanup
	 * 
	 * @param {PointCloudOctreeGeometryNode} geometryNode - Geometry to convert
	 * @param {PointCloudOctreeNode} [parent] - Parent tree node (null = root)
	 * @returns {PointCloudOctreeNode} Scene tree node ready for rendering
	 */
	toTreeNode (geometryNode, parent) {
		let node = new PointCloudOctreeNode();

		// Create THREE.Points object (geometry + material for rendering)
		let sceneNode = new THREE.Points(geometryNode.geometry, this.material);
		sceneNode.name = geometryNode.name;
		sceneNode.position.copy(geometryNode.boundingBox.min);
		sceneNode.frustumCulled = false; // We handle culling in PotreeRenderer, not Three.js
		
		// Pre-render hook: update material uniforms specific to this node
		sceneNode.onBeforeRender = (_this, scene, camera, geometry, material, group) => {
			if (material.program) {
				_this.getContext().useProgram(material.program.program);

				// Update octree level uniform (for debug visualization)
				if (material.program.getUniforms().map.level) {
					let level = geometryNode.getLevel();
					material.uniforms.level.value = level;
					material.program.getUniforms().map.level.setValue(_this.getContext(), level);
				}

				// Update visibility node texture offset
				if (this.visibleNodeTextureOffsets && material.program.getUniforms().map.vnStart) {
					let vnStart = this.visibleNodeTextureOffsets.get(node);
					material.uniforms.vnStart.value = vnStart;
					material.program.getUniforms().map.vnStart.setValue(_this.getContext(), vnStart);
				}

				// Update point cloud index (for multi-cloud scenes)
				if (material.program.getUniforms().map.pcIndex) {
					let i = node.pcIndex ? node.pcIndex : this.visibleNodes.indexOf(node);
					material.uniforms.pcIndex.value = i;
					material.program.getUniforms().map.pcIndex.setValue(_this.getContext(), i);
				}
			}
		};

		// Link geometry node to scene node
		node.geometryNode = geometryNode;
		node.sceneNode = sceneNode;
		node.pointcloud = this;
		node.children = [];
		
		// Copy child references from geometry node
		for(let i = 0; i < 8; i++){
			node.children[i] = geometryNode.children[i];
		}

		// Add to scene graph
		if (!parent) {
			// This is the root node
			this.root = node;
			this.add(sceneNode);
		} else {
			// This is a child node
			let childIndex = parseInt(geometryNode.name[geometryNode.name.length - 1]);
			parent.sceneNode.add(sceneNode);
			parent.children[childIndex] = node;
		}

		// Set up memory cleanup when node is disposed
		let disposeListener = function () {
			let childIndex = parseInt(geometryNode.name[geometryNode.name.length - 1]);
			parent.sceneNode.remove(node.sceneNode);
			parent.children[childIndex] = geometryNode;
		};
		geometryNode.oneTimeDisposeHandlers.push(disposeListener);

		return node;
	}

	updateVisibleBounds () {
		let leafNodes = [];
		for (let i = 0; i < this.visibleNodes.length; i++) {
			let node = this.visibleNodes[i];
			let isLeaf = true;

			for (let j = 0; j < node.children.length; j++) {
				let child = node.children[j];
				if (child instanceof PointCloudOctreeNode) {
					isLeaf = isLeaf && !child.sceneNode.visible;
				} else if (child instanceof PointCloudOctreeGeometryNode) {
					isLeaf = true;
				}
			}

			if (isLeaf) {
				leafNodes.push(node);
			}
		}

		this.visibleBounds.min = new THREE.Vector3(Infinity, Infinity, Infinity);
		this.visibleBounds.max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
		for (let i = 0; i < leafNodes.length; i++) {
			let node = leafNodes[i];

			this.visibleBounds.expandByPoint(node.getBoundingBox().min);
			this.visibleBounds.expandByPoint(node.getBoundingBox().max);
		}
	}

	updateMaterial (material, visibleNodes, camera, renderer) {
		material.fov = camera.fov * (Math.PI / 180);
		material.screenWidth = renderer.domElement.clientWidth;
		material.screenHeight = renderer.domElement.clientHeight;
		material.spacing = this.pcoGeometry.spacing; // * Math.max(this.scale.x, this.scale.y, this.scale.z);
		material.near = camera.near;
		material.far = camera.far;
		material.uniforms.octreeSize.value = this.pcoGeometry.boundingBox.getSize(new THREE.Vector3()).x;
	}

	computeVisibilityTextureData(nodes, camera){

		if(Potree.measureTimings) performance.mark("computeVisibilityTextureData-start");

		let data = new Uint8Array(nodes.length * 4);
		let visibleNodeTextureOffsets = new Map();

		// copy array
		nodes = nodes.slice();

		// sort by level and index, e.g. r, r0, r3, r4, r01, r07, r30, ...
		let sort = function (a, b) {
			let na = a.geometryNode.name;
			let nb = b.geometryNode.name;
			if (na.length !== nb.length) return na.length - nb.length;
			if (na < nb) return -1;
			if (na > nb) return 1;
			return 0;
		};
		nodes.sort(sort);

		let worldDir = new THREE.Vector3();

		let nodeMap = new Map();
		let offsetsToChild = new Array(nodes.length).fill(Infinity);

		for(let i = 0; i < nodes.length; i++){
			let node = nodes[i];

			nodeMap.set(node.name, node);
			visibleNodeTextureOffsets.set(node, i);

			if(i > 0){
				let index = parseInt(node.name.slice(-1));
				let parentName = node.name.slice(0, -1);
				let parent = nodeMap.get(parentName);
				let parentOffset = visibleNodeTextureOffsets.get(parent);

				let parentOffsetToChild = (i - parentOffset);

				offsetsToChild[parentOffset] = Math.min(offsetsToChild[parentOffset], parentOffsetToChild);

				data[parentOffset * 4 + 0] = data[parentOffset * 4 + 0] | (1 << index);
				data[parentOffset * 4 + 1] = (offsetsToChild[parentOffset] >> 8);
				data[parentOffset * 4 + 2] = (offsetsToChild[parentOffset] % 256);
			}

			let density = node.geometryNode.density;
			
			if(typeof density === "number" && !Number.isNaN(density)){
				let lodOffset = Math.log2(density) / 2 - 1.5;

				let offsetUint8 = (lodOffset + 10) * 10;

				data[i * 4 + 3] = offsetUint8;
			}else{
				data[i * 4 + 3] = 100;
			}

		}

		if(Potree.measureTimings){
			performance.mark("computeVisibilityTextureData-end");
			performance.measure("render.computeVisibilityTextureData", "computeVisibilityTextureData-start", "computeVisibilityTextureData-end");
		}

		return {
			data: data,
			offsets: visibleNodeTextureOffsets
		};
	}

	nodeIntersectsProfile (node, profile) {
		let bbWorld = node.boundingBox.clone().applyMatrix4(this.matrixWorld);
		let bsWorld = bbWorld.getBoundingSphere(new THREE.Sphere());

		let intersects = false;

		for (let i = 0; i < profile.points.length - 1; i++) {

			let start = new THREE.Vector3(profile.points[i + 0].x, profile.points[i + 0].y, bsWorld.center.z);
			let end = new THREE.Vector3(profile.points[i + 1].x, profile.points[i + 1].y, bsWorld.center.z);

			let closest = new THREE.Line3(start, end).closestPointToPoint(bsWorld.center, true, new THREE.Vector3());
			let distance = closest.distanceTo(bsWorld.center);

			intersects = intersects || (distance < (bsWorld.radius + profile.width));
		}

		//console.log(`${node.name}: ${intersects}`);

		return intersects;
	}

	deepestNodeAt(position){
		
		const toObjectSpace = this.matrixWorld.clone().invert();

		const objPos = position.clone().applyMatrix4(toObjectSpace);

		let current = this.root;
		while(true){

			let containingChild = null;

			for(const child of current.children){

				if(child !== undefined){
					if(child.getBoundingBox().containsPoint(objPos)){
						containingChild = child;
					}
				}
			}

			if(containingChild !== null && containingChild instanceof PointCloudOctreeNode){
				current = containingChild;
			}else{
				break;
			}
		}

		const deepest = current;

		return deepest;
	}

	nodesOnRay (nodes, ray) {
		let nodesOnRay = [];

		let _ray = ray.clone();
		for (let i = 0; i < nodes.length; i++) {
			let node = nodes[i];
			let sphere = node.getBoundingSphere().clone().applyMatrix4(this.matrixWorld);

			if (_ray.intersectsSphere(sphere)) {
				nodesOnRay.push(node);
			}
		}

		return nodesOnRay;
	}

	updateMatrixWorld (force) {
		if (this.matrixAutoUpdate === true) this.updateMatrix();

		if (this.matrixWorldNeedsUpdate === true || force === true) {
			if (!this.parent) {
				this.matrixWorld.copy(this.matrix);
			} else {
				this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
			}

			this.matrixWorldNeedsUpdate = false;

			force = true;
		}
	}

	hideDescendants (object) {
		let stack = [];
		for (let i = 0; i < object.children.length; i++) {
			let child = object.children[i];
			if (child.visible) {
				stack.push(child);
			}
		}

		while (stack.length > 0) {
			let object = stack.shift();

			object.visible = false;

			for (let i = 0; i < object.children.length; i++) {
				let child = object.children[i];
				if (child.visible) {
					stack.push(child);
				}
			}
		}
	}

	moveToOrigin () {
		this.position.set(0, 0, 0);
		this.updateMatrixWorld(true);
		let box = this.boundingBox;
		let transform = this.matrixWorld;
		let tBox = Utils.computeTransformedBoundingBox(box, transform);
		this.position.set(0, 0, 0).sub(tBox.getCenter(new THREE.Vector3()));
	};

	moveToGroundPlane () {
		this.updateMatrixWorld(true);
		let box = this.boundingBox;
		let transform = this.matrixWorld;
		let tBox = Utils.computeTransformedBoundingBox(box, transform);
		this.position.y += -tBox.min.y;
	};

	getBoundingBoxWorld () {
		this.updateMatrixWorld(true);
		let box = this.boundingBox;
		let transform = this.matrixWorld;
		let tBox = Utils.computeTransformedBoundingBox(box, transform);

		return tBox;
	};

	/**
	 * returns points inside the profile points
	 *
	 * maxDepth:		search points up to the given octree depth
	 *
	 *
	 * The return value is an array with all segments of the profile path
	 *	let segment = {
	 *		start:	THREE.Vector3,
	 *		end:	THREE.Vector3,
	 *		points: {}
	 *		project: function()
	 *	};
	 *
	 * The project() function inside each segment can be used to transform
	 * that segments point coordinates to line up along the x-axis.
	 *
	 *
	 */
	getPointsInProfile (profile, maxDepth, callback) {
		if (callback) {
			let request = new Potree.ProfileRequest(this, profile, maxDepth, callback);
			this.profileRequests.push(request);

			return request;
		}

		let points = {
			segments: [],
			boundingBox: new THREE.Box3(),
			projectedBoundingBox: new THREE.Box2()
		};

		// evaluate segments
		for (let i = 0; i < profile.points.length - 1; i++) {
			let start = profile.points[i];
			let end = profile.points[i + 1];
			let ps = this.getProfile(start, end, profile.width, maxDepth);

			let segment = {
				start: start,
				end: end,
				points: ps,
				project: null
			};

			points.segments.push(segment);

			points.boundingBox.expandByPoint(ps.boundingBox.min);
			points.boundingBox.expandByPoint(ps.boundingBox.max);
		}

		// add projection functions to the segments
		let mileage = new THREE.Vector3();
		for (let i = 0; i < points.segments.length; i++) {
			let segment = points.segments[i];
			let start = segment.start;
			let end = segment.end;

			let project = (function (_start, _end, _mileage, _boundingBox) {
				let start = _start;
				let end = _end;
				let mileage = _mileage;
				let boundingBox = _boundingBox;

				let xAxis = new THREE.Vector3(1, 0, 0);
				let dir = new THREE.Vector3().subVectors(end, start);
				dir.y = 0;
				dir.normalize();
				let alpha = Math.acos(xAxis.dot(dir));
				if (dir.z > 0) {
					alpha = -alpha;
				}

				return function (position) {
					let toOrigin = new THREE.Matrix4().makeTranslation(-start.x, -boundingBox.min.y, -start.z);
					let alignWithX = new THREE.Matrix4().makeRotationY(-alpha);
					let applyMileage = new THREE.Matrix4().makeTranslation(mileage.x, 0, 0);

					let pos = position.clone();
					pos.applyMatrix4(toOrigin);
					pos.applyMatrix4(alignWithX);
					pos.applyMatrix4(applyMileage);

					return pos;
				};
			}(start, end, mileage.clone(), points.boundingBox.clone()));

			segment.project = project;

			mileage.x += new THREE.Vector3(start.x, 0, start.z).distanceTo(new THREE.Vector3(end.x, 0, end.z));
			mileage.y += end.y - start.y;
		}

		points.projectedBoundingBox.min.x = 0;
		points.projectedBoundingBox.min.y = points.boundingBox.min.y;
		points.projectedBoundingBox.max.x = mileage.x;
		points.projectedBoundingBox.max.y = points.boundingBox.max.y;

		return points;
	}

	/**
	 * returns points inside the given profile bounds.
	 *
	 * start:
	 * end:
	 * width:
	 * depth:		search points up to the given octree depth
	 * callback:	if specified, points are loaded before searching
	 *
	 *
	 */
	getProfile (start, end, width, depth, callback) {
		let request = new Potree.ProfileRequest(start, end, width, depth, callback);
		this.profileRequests.push(request);
	};

	getVisibleExtent () {
		return this.visibleBounds.applyMatrix4(this.matrixWorld);
	};

	intersectsPoint(position){

		let rootAvailable = this.pcoGeometry.root && this.pcoGeometry.root.geometry;

		if(!rootAvailable){
			return false;
		}

		if(typeof this.signedDistanceField === "undefined"){

			const resolution = 32;
			const field = new Float32Array(resolution ** 3).fill(Infinity);

			const positions = this.pcoGeometry.root.geometry.attributes.position;
			const boundingBox = this.boundingBox;

			const n = positions.count;

			for(let i = 0; i < n; i = i + 3){
				const x = positions.array[3 * i + 0];
				const y = positions.array[3 * i + 1];
				const z = positions.array[3 * i + 2];

				const ix = parseInt(Math.min(resolution * (x / boundingBox.max.x), resolution - 1));
				const iy = parseInt(Math.min(resolution * (y / boundingBox.max.y), resolution - 1));
				const iz = parseInt(Math.min(resolution * (z / boundingBox.max.z), resolution - 1));

				const index = ix + iy * resolution + iz * resolution * resolution;

				field[index] = 0;
			}

			const sdf = {
				resolution: resolution,
				field: field,
			};

			this.signedDistanceField = sdf;
		}


		{
			const sdf = this.signedDistanceField;
			const boundingBox = this.boundingBox;

			const toObjectSpace = this.matrixWorld.clone().invert();

			const objPos = position.clone().applyMatrix4(toObjectSpace);

			const resolution = sdf.resolution;
			const ix = parseInt(resolution * (objPos.x / boundingBox.max.x));
			const iy = parseInt(resolution * (objPos.y / boundingBox.max.y));
			const iz = parseInt(resolution * (objPos.z / boundingBox.max.z));

			if(ix < 0 || iy < 0 || iz < 0){
				return false;
			}
			if(ix >= resolution || iy >= resolution || iz >= resolution){
				return false;
			}

			const index = ix + iy * resolution + iz * resolution * resolution;

			const value = sdf.field[index];

			if(value === 0){
				return true;
			}

		}

		return false;

	}

	/**
	 *
	 *
	 *
	 * params.pickWindowSize:	Look for points inside a pixel window of this size.
	 *							Use odd values: 1, 3, 5, ...
	 *
	 *
	 * TODO: only draw pixels that are actually read with readPixels().
	 *
	 */
	pick(viewer, camera, ray, params = {}){

		let renderer = viewer.renderer;
		let pRenderer = viewer.pRenderer;

		performance.mark("pick-start");

		let getVal = (a, b) => a !== undefined ? a : b;

		let pickWindowSize = getVal(params.pickWindowSize, 65);
		let pickOutsideClipRegion = getVal(params.pickOutsideClipRegion, false);

		let size = renderer.getSize(new THREE.Vector2());

		let width = Math.ceil(getVal(params.width, size.width));
		let height = Math.ceil(getVal(params.height, size.height));

		let pointSizeType = getVal(params.pointSizeType, this.material.pointSizeType);
		let pointSize = getVal(params.pointSize, this.material.size);

		let nodes = this.nodesOnRay(this.visibleNodes, ray);

		if (nodes.length === 0) {
			return null;
		}

		if (!this.pickState) {
			let scene = new THREE.Scene();

			let material = new Potree.PointCloudMaterial();
			material.activeAttributeName = "indices";

			let renderTarget = new THREE.WebGLRenderTarget(
				1, 1,
				{ minFilter: THREE.LinearFilter,
					magFilter: THREE.NearestFilter,
					format: THREE.RGBAFormat }
			);

			this.pickState = {
				renderTarget: renderTarget,
				material: material,
				scene: scene
			};
		};

		let pickState = this.pickState;
		let pickMaterial = pickState.material;

		{ // update pick material
			pickMaterial.pointSizeType = pointSizeType;
			//pickMaterial.shape = this.material.shape;
			pickMaterial.shape = Potree.PointShape.PARABOLOID;

			pickMaterial.uniforms.uFilterReturnNumberRange.value = this.material.uniforms.uFilterReturnNumberRange.value;
			pickMaterial.uniforms.uFilterNumberOfReturnsRange.value = this.material.uniforms.uFilterNumberOfReturnsRange.value;
			pickMaterial.uniforms.uFilterGPSTimeClipRange.value = this.material.uniforms.uFilterGPSTimeClipRange.value;
			pickMaterial.uniforms.uFilterPointSourceIDClipRange.value = this.material.uniforms.uFilterPointSourceIDClipRange.value;

			pickMaterial.activeAttributeName = "indices";

			pickMaterial.size = pointSize;
			pickMaterial.uniforms.minSize.value = this.material.uniforms.minSize.value;
			pickMaterial.uniforms.maxSize.value = this.material.uniforms.maxSize.value;
			pickMaterial.classification = this.material.classification;
			pickMaterial.recomputeClassification();

			if(params.pickClipped){
				pickMaterial.clipBoxes = this.material.clipBoxes;
				pickMaterial.uniforms.clipBoxes = this.material.uniforms.clipBoxes;
				if(this.material.clipTask === Potree.ClipTask.HIGHLIGHT){
					pickMaterial.clipTask = Potree.ClipTask.NONE;
				}else{
					pickMaterial.clipTask = this.material.clipTask;
				}
				pickMaterial.clipMethod = this.material.clipMethod;
			}else{
				pickMaterial.clipBoxes = [];
			}

			this.updateMaterial(pickMaterial, nodes, camera, renderer);
		}

		pickState.renderTarget.setSize(width, height);

		let pixelPos = new THREE.Vector2(params.x, params.y);

		let gl = renderer.getContext();
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(
			parseInt(pixelPos.x - (pickWindowSize - 1) / 2),
			parseInt(pixelPos.y - (pickWindowSize - 1) / 2),
			parseInt(pickWindowSize), parseInt(pickWindowSize));


		renderer.state.buffers.depth.setTest(pickMaterial.depthTest);
		renderer.state.buffers.depth.setMask(pickMaterial.depthWrite);
		renderer.state.setBlending(THREE.NoBlending);

		{ // RENDER
			renderer.setRenderTarget(pickState.renderTarget);
			gl.clearColor(0, 0, 0, 0);
			renderer.clear(true, true, true);

			let tmp = this.material;
			this.material = pickMaterial;

			pRenderer.renderOctree(this, nodes, camera, pickState.renderTarget);

			this.material = tmp;
		}

		let clamp = (number, min, max) => Math.min(Math.max(min, number), max);

		let x = parseInt(clamp(pixelPos.x - (pickWindowSize - 1) / 2, 0, width));
		let y = parseInt(clamp(pixelPos.y - (pickWindowSize - 1) / 2, 0, height));
		let w = parseInt(Math.min(x + pickWindowSize, width) - x);
		let h = parseInt(Math.min(y + pickWindowSize, height) - y);

		let pixelCount = w * h;
		let buffer = new Uint8Array(4 * pixelCount);

		gl.readPixels(x, y, pickWindowSize, pickWindowSize, gl.RGBA, gl.UNSIGNED_BYTE, buffer);

		renderer.setRenderTarget(null);
		renderer.state.reset();
		renderer.setScissorTest(false);
		gl.disable(gl.SCISSOR_TEST);

		let pixels = buffer;
		let ibuffer = new Uint32Array(buffer.buffer);

		// find closest hit inside pixelWindow boundaries
		let min = Number.MAX_VALUE;
		let hits = [];
		for (let u = 0; u < pickWindowSize; u++) {
			for (let v = 0; v < pickWindowSize; v++) {
				let offset = (u + v * pickWindowSize);
				let distance = Math.pow(u - (pickWindowSize - 1) / 2, 2) + Math.pow(v - (pickWindowSize - 1) / 2, 2);

				let pcIndex = pixels[4 * offset + 3];
				pixels[4 * offset + 3] = 0;
				let pIndex = ibuffer[offset];

				if(!(pcIndex === 0 && pIndex === 0) && (pcIndex !== undefined) && (pIndex !== undefined)){
					let hit = {
						pIndex: pIndex,
						pcIndex: pcIndex,
						distanceToCenter: distance
					};

					if(params.all){
						hits.push(hit);
					}else{
						if(hits.length > 0){
							if(distance < hits[0].distanceToCenter){
								hits[0] = hit;
							}
						}else{
							hits.push(hit);
						}
					}


				}
			}
		}

		
		// { // DEBUG: show panel with pick image
		// 	let img = Utils.pixelsArrayToImage(buffer, w, h);
		// 	let screenshot = img.src;
		
		// 	if(!this.debugDIV){
		// 		this.debugDIV = $(`
		// 			<div id="pickDebug"
		// 			style="position: absolute;
		// 			right: 400px; width: 300px;
		// 			bottom: 44px; width: 300px;
		// 			z-index: 1000;
		// 			"></div>`);
		// 		$(document.body).append(this.debugDIV);
		// 	}
		
		// 	this.debugDIV.empty();
		// 	this.debugDIV.append($(`<img src="${screenshot}"
		// 		style="transform: scaleY(-1); width: 300px"/>`));
		// 	//$(this.debugWindow.document).append($(`<img src="${screenshot}"/>`));
		// 	//this.debugWindow.document.write('<img src="'+screenshot+'"/>');
		// }


		for(let hit of hits){
			let point = {};

			if (!nodes[hit.pcIndex]) {
				return null;
			}

			let node = nodes[hit.pcIndex];
			let pc = node.sceneNode;
			let geometry = node.geometryNode.geometry;

			for(let attributeName in geometry.attributes){
				let attribute = geometry.attributes[attributeName];

				if (attributeName === 'position') {
					let x = attribute.array[3 * hit.pIndex + 0];
					let y = attribute.array[3 * hit.pIndex + 1];
					let z = attribute.array[3 * hit.pIndex + 2];

					let position = new THREE.Vector3(x, y, z);
					position.applyMatrix4(pc.matrixWorld);

					point[attributeName] = position;
				} else if (attributeName === 'indices') {

				} else {

					let values = attribute.array.slice(attribute.itemSize * hit.pIndex, attribute.itemSize * (hit.pIndex + 1)) ;

					if(attribute.potree){
						const {scale, offset} = attribute.potree;
						values = values.map(v => v / scale + offset);
					}

					point[attributeName] = values;

					//debugger;
					//if (values.itemSize === 1) {
					//	point[attribute.name] = values.array[hit.pIndex];
					//} else {
					//	let value = [];
					//	for (let j = 0; j < values.itemSize; j++) {
					//		value.push(values.array[values.itemSize * hit.pIndex + j]);
					//	}
					//	point[attribute.name] = value;
					//}
				}

			}

			hit.point = point;
		}

		performance.mark("pick-end");
		performance.measure("pick", "pick-start", "pick-end");

		if(params.all){
			return hits.map(hit => hit.point);
		}else{
			if(hits.length === 0){
				return null;
			}else{
				return hits[0].point;
				//let sorted = hits.sort( (a, b) => a.distanceToCenter - b.distanceToCenter);

				//return sorted[0].point;
			}
		}

	};

	* getFittedBoxGen(boxNode){
		let start = performance.now();

		let shrinkedLocalBounds = new THREE.Box3();
		let worldToBox = boxNode.matrixWorld.clone().invert();

		for(let node of this.visibleNodes){
			if(!node.sceneNode){
				continue;
			}

			let buffer = node.geometryNode.buffer;

			let posOffset = buffer.offset("position");
			let stride = buffer.stride;
			let view = new DataView(buffer.data);

			let objectToBox = new THREE.Matrix4().multiplyMatrices(worldToBox, node.sceneNode.matrixWorld);

			let pos = new THREE.Vector4();
			for(let i = 0; i < buffer.numElements; i++){
				let x = view.getFloat32(i * stride + posOffset + 0, true);
				let y = view.getFloat32(i * stride + posOffset + 4, true);
				let z = view.getFloat32(i * stride + posOffset + 8, true);

				pos.set(x, y, z, 1);
				pos.applyMatrix4(objectToBox);

				if(-0.5 < pos.x && pos.x < 0.5){
					if(-0.5 < pos.y && pos.y < 0.5){
						if(-0.5 < pos.z && pos.z < 0.5){
							shrinkedLocalBounds.expandByPoint(pos);
						}
					}
				}
			}

			yield;
		}

		let fittedPosition = shrinkedLocalBounds.getCenter(new THREE.Vector3()).applyMatrix4(boxNode.matrixWorld);

		let fitted = new THREE.Object3D();
		fitted.position.copy(fittedPosition);
		fitted.scale.copy(boxNode.scale);
		fitted.rotation.copy(boxNode.rotation);

		let ds = new THREE.Vector3().subVectors(shrinkedLocalBounds.max, shrinkedLocalBounds.min);
		fitted.scale.multiply(ds);

		let duration = performance.now() - start;
		console.log("duration: ", duration);

		yield fitted;
	}

	getFittedBox(boxNode, maxLevel = Infinity){

		maxLevel = Infinity;

		let start = performance.now();

		let shrinkedLocalBounds = new THREE.Box3();
		let worldToBox = boxNode.matrixWorld.clone().invert();

		for(let node of this.visibleNodes){
			if(!node.sceneNode || node.getLevel() > maxLevel){
				continue;
			}

			let buffer = node.geometryNode.buffer;

			let posOffset = buffer.offset("position");
			let stride = buffer.stride;
			let view = new DataView(buffer.data);

			let objectToBox = new THREE.Matrix4().multiplyMatrices(worldToBox, node.sceneNode.matrixWorld);

			let pos = new THREE.Vector4();
			for(let i = 0; i < buffer.numElements; i++){
				let x = view.getFloat32(i * stride + posOffset + 0, true);
				let y = view.getFloat32(i * stride + posOffset + 4, true);
				let z = view.getFloat32(i * stride + posOffset + 8, true);

				pos.set(x, y, z, 1);
				pos.applyMatrix4(objectToBox);

				if(-0.5 < pos.x && pos.x < 0.5){
					if(-0.5 < pos.y && pos.y < 0.5){
						if(-0.5 < pos.z && pos.z < 0.5){
							shrinkedLocalBounds.expandByPoint(pos);
						}
					}
				}
			}
		}

		let fittedPosition = shrinkedLocalBounds.getCenter(new THREE.Vector3()).applyMatrix4(boxNode.matrixWorld);

		let fitted = new THREE.Object3D();
		fitted.position.copy(fittedPosition);
		fitted.scale.copy(boxNode.scale);
		fitted.rotation.copy(boxNode.rotation);

		let ds = new THREE.Vector3().subVectors(shrinkedLocalBounds.max, shrinkedLocalBounds.min);
		fitted.scale.multiply(ds);

		let duration = performance.now() - start;
		console.log("duration: ", duration);

		return fitted;
	}

	get progress () {
		return this.visibleNodes.length / this.visibleGeometry.length;
	}

	find(name){
		let node = null;
		for(let char of name){
			if(char === "r"){
				node = this.root;
			}else{
				node = node.children[char];
			}
		}

		return node;
	}

	get visible(){
		return this._visible;
	}

	set visible(value){

		if(value !== this._visible){
			this._visible = value;

			this.dispatchEvent({type: 'visibility_changed', pointcloud: this});
		}

	}

}










