# Goal Description

Fix the issue where touching and clicking Shapefile features does not display the information box in the Vercel production environment, despite working locally.

The root cause is a mathematical flaw in the grid-based spatial index (`_buildSpatialIndex`) which is triggered only for large layers (like production datasets >1000 features). The method `_getSpatialCandidates` uses `ray.closestPointToPoint` against the center of the bounding box to find the cell the user clicked on. However, this returns a point along the ray closest to the center, rather than the actual intersection of the ray with the layer's 2D plane (Z-elevation). This results in looking up completely wrong spatial grid cells, returning no candidate features, and thus causing the pick logic to fail silently. 

Additionally, the Vercel `proxy-layer.js` buffers the entire file in memory before sending. This hits Vercel's 4.5MB Serverless Function payload limit for large `.dbf` files (common in production), which can lead to empty attribute tables.

## Proposed Changes

### `src/utils/GisLayer.js`

- **Update `_getSpatialCandidates`**: Replace the flawed `closestPointToPoint` logic with mathematically correct `ray.intersectPlane()`. We will define a plane at the average Z-elevation of the layer, intersect the camera's ray with this plane, and use the exact XY intersection coordinate to look up the correct candidate cells.
- **Matrix Inversion Compatibility**: Update `getInverse(this.matrixWorld)` to use `.invert()` if available, maintaining backwards compatibility with older Three.js versions.

### `api/proxy-layer.js`

- **Enable Stream Piping**: Instead of using `await response.arrayBuffer()` and `Buffer.from()`, convert the fetch response body into a Node stream and `.pipe(res)` directly to the client. This reduces memory pressure and helps circumvent standard buffering limitations for large shapefile `.dbf` files.

## User Review Required

Please review the proposed mathematical fix for the spatial index intersection and the proxy stream optimization. If you approve, I will implement these fixes.

## Verification Plan

### Automated Tests
- None available in current setup.

### Manual Verification
- Deploy to Vercel or test locally with a shapefile containing >1000 features.
- Click on features at the edges of the bounding box; verify the information box displays correctly with attribute data.
- Verify large `.dbf` files load attributes properly without 500 errors in the Network tab.
