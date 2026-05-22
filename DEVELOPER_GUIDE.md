# Potree CloudHub Caribe - Developer Guide

## Project Overview

**Potree CloudHub Caribe** is a WebGL-based point cloud visualization and management platform. It allows users to upload, convert, and interactively visualize massive LiDAR datasets in a web browser using hierarchical octree-based Level-of-Detail (LOD) rendering.

- **Frontend**: Three.js WebGL rendering, modern JavaScript, responsive HTML5
- **Backend**: Node.js Express server, Vercel serverless API, Azure Blob Storage
- **Data**: Supports LAS, LAZ, EPT (Entwine Point Tile), GeoPackage, and Shapefile formats
- **Scale**: Billions of points, terabytes of data

---

## Architecture Overview

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────┐
│ FRONTEND (Browser)                                          │
├─────────────────────────────────────────────────────────────┤
│ public/index.html      -> Dashboard (project management)    │
│ public/viewer.html     -> Point cloud viewer                │
│ public/app.js          -> Dashboard logic                   │
│ src/viewer/viewer.js   -> Viewer controller                 │
│ src/PointCloudOctree   -> Octree data structure            │
│ src/PotreeRenderer     -> Rendering/visibility culling     │
│ src/loader/*           -> Format loaders (LAS, LAZ, etc)   │
└─────────────────────────────────────────────────────────────┘
                            ↓
          HTTP API (/api/*) | Static Files
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ BACKEND                                                     │
├─────────────────────────────────────────────────────────────┤
│ Local Server (development/Azure App Service):               │
│   server/index.js      -> Express app entry point           │
│   api/*                -> API route handlers                │
│   server/routes/*      -> Route implementations             │
│                                                             │
│ Serverless (Vercel):                                        │
│   api/*.js             -> Vercel functions                  │
│   api/_lib/azure.js    -> Azure client utilities            │
└─────────────────────────────────────────────────────────────┘
                            ↓
        File Storage | Azure Blob | LAS/LAZ Conversion
```

### Key Modules

#### Frontend (src/)

| Module                              | Purpose                        | Key Classes                             |
| ----------------------------------- | ------------------------------ | --------------------------------------- |
| **PointCloudOctree.js**             | Hierarchical spatial structure | PointCloudOctree, PointCloudOctreeNode  |
| **PotreeRenderer.js**               | Rendering engine & LOD         | Renderer, Shader, WebGLBuffer           |
| **viewer/viewer.js**                | Main viewer UI                 | Viewer (extends EventDispatcher)        |
| **viewer/Scene.js**                 | Three.js scene management      | Scene                                   |
| **viewer/View.js**                  | Camera & viewport              | View                                    |
| **loader/LasLazLoader.js**          | LAS/LAZ format loading         | LasLazLoader, LasLazBatcher             |
| **loader/EptLoader.js**             | Entwine Point Tile format      | EptLoader                               |
| **loader/POCLoader.js**             | Potree native format           | POCLoader                               |
| **materials/PointCloudMaterial.js** | GPU shader material            | PointCloudMaterial                      |
| **EventDispatcher.js**              | Event system (Pub-Sub)         | EventDispatcher                         |
| \*_utils/_                          | Tools & utilities              | MeasuringTool, ClippingTool, Annotation |

#### Backend (server/ & api/)

| Module                 | Purpose                | Key Exports                           |
| ---------------------- | ---------------------- | ------------------------------------- |
| **server/index.js**    | Express app setup      | app.listen()                          |
| **api/upload.js**      | File upload handler    | POST /api/upload                      |
| **api/list.js**        | List projects          | GET /api/list                         |
| **api/config.js**      | Platform config        | GET /api/config                       |
| **api/projects.js**    | Project CRUD           | POST /api/projects                    |
| **api/status/**        | Conversion status      | GET /api/status/:id                   |
| **api/\_lib/azure.js** | Azure client utilities | getAzureClients(), listBlobProjects() |

---

## Getting Started for New Developers

### 1. Understand the Rendering Pipeline

**The most important concept is octree-based LOD rendering:**

1. **Octree Structure**: Point cloud stored as tree of spatial cells (8 children per node)
2. **Frustum Culling**: Only render nodes visible to camera
3. **Pixel Size Culling**: Skip nodes smaller than N pixels on screen
4. **Point Budget**: Cap visible points at ~2-4M for 60fps
5. **GPU Rendering**: All visible points rendered in one batch with shared material

**Key File**: `src/PotreeRenderer.js` - Contains visibility culling and LOD logic

### 2. Loading Point Clouds

```javascript
// Example: Load a point cloud
import { PointCloudOctree } from "./PointCloudOctree.js";
import { POCLoader } from "./loader/POCLoader.js";

const loader = new POCLoader();
const geometry = await loader.load("pointclouds/mycloud.json");
const pointcloud = new PointCloudOctree(geometry);
scene.addPointCloud(pointcloud);
```

**Supported Formats**:

- **LAS/LAZ**: Industry standard LiDAR format (`LasLazLoader.js`)
- **EPT**: Entwine Point Tile cloud format (`EptLoader.js`)
- **POC**: Potree octree format (`POCLoader.js`)
- **GeoPackage**: GIS data format (`GeoPackageLoader.js`)
- **Shapefile**: Vector GIS format (`ShapefileLoader.js`)

### 3. Color Schemes & Attributes

Point clouds can be rendered with different attributes:

```javascript
// Available rendering attributes
const attributes = pointcloud.getAttributes();
// Typically includes: position, color/rgba, intensity,
// classification, gpsTime, returnNumber, etc.

// Switch rendering attribute
pointcloud.material.activeAttributeName = "intensity";
```

**Classification Scheme** (LiDAR standard):

- 0 = Not classified
- 1 = Unassigned
- 2 = Ground
- 3 = Low vegetation
- 5 = Medium vegetation
- 6 = High vegetation
- 17 = Bridge deck
- ... (see materials/ClassificationScheme.js)

### 4. Viewer Controls

The viewer supports multiple navigation modes:

- **Orbit**: Rotate around a point (default)
- **First Person**: WASD movement with mouse look
- **Earth**: Globe-like panning/zooming
- **VR**: WebXR/VR headset support

**Key Input**:

- Mouse: Right-click drag to orbit, scroll to zoom
- Keyboard: Arrow keys to pan, +/- to zoom
- Tools: Measure, annotate, clip, profile via sidebar

### 5. Material & Shader System

GPU rendering uses custom GLSL shaders via `PointCloudMaterial.js`:

```glsl
// Point color determined by active attribute
if (activeAttributeName == 'rgb') {
  color = mix(color, attributeColor, 1.0);
} else if (activeAttributeName == 'intensity') {
  color = intensityGradient(intensity, intensityMin, intensityMax);
} else if (activeAttributeName == 'classification') {
  color = classificationScheme[classification];
}
```

Key uniforms:

- `intensityMin/Max`: Gradient range
- `elevationMin/Max`: Elevation color range
- `clippingVolumes`: Array of clip box positions
- `pointSize`: Point size in pixels

### 6. Event System

Components communicate via events (Observer pattern):

```javascript
// Listen to point cloud events
pointcloud.addEventListener("name_changed", (event) => {
  console.log("Point cloud renamed to:", event.name);
});

// Listen to viewer events
viewer.addEventListener("camera_changed", (event) => {
  console.log("Camera position:", viewer.scene.getActiveCamera().position);
});

// Dispatch custom events
this.dispatchEvent({
  type: "my_event",
  data: {
    /* ... */
  },
});
```

**Common Events**:

- `pointcloud_added` / `pointcloud_removed`
- `name_changed`
- `visibility_changed`
- `camera_changed`
- `measurement_complete`
- `annotation_added`

---

## Development Workflow

### Local Development

```bash
# Install dependencies
npm install

# Build (Gulp + Rollup)
npm run build

# Start local server
npm start
# Server runs on http://localhost:3000

# Development mode (watch for changes)
npm run dev
```

### File Organization

```
potree/
├── public/               # Frontend static files (served at /)
│   ├── index.html       # Dashboard
│   ├── viewer.html      # Viewer
│   ├── app.js           # Dashboard logic
│   └── style.css
├── src/                 # Source code (gets built to build/)
│   ├── Potree.js        # Main export barrel
│   ├── PointCloudOctree.js
│   ├── PotreeRenderer.js
│   ├── viewer/
│   ├── loader/
│   ├── materials/
│   ├── utils/
│   └── ...
├── build/               # Built output (compiled potree.js)
├── libs/                # Third-party libraries (Three.js, etc)
├── server/              # Node.js backend
│   ├── index.js
│   ├── startup.js
│   ├── config/
│   ├── routes/
│   ├── middleware/
│   └── services/
├── api/                 # Vercel serverless functions
│   ├── upload.js
│   ├── list.js
│   ├── config.js
│   ├── projects.js
│   └── _lib/
├── gulpfile.js          # Build configuration
├── rollup.config.js     # Rollup bundler config
└── package.json
```

### Adding New Features

#### Example: Adding a new visualization mode

1. **Create shader variant** in `src/materials/PointCloudMaterial.js`
2. **Add attribute/uniform** to material properties
3. **Update viewer UI** in `src/viewer/sidebar.js`
4. **Dispatch event** when mode changes

#### Example: Adding a new file format loader

1. **Create loader class** in `src/loader/MyFormatLoader.js`
2. **Implement load() method** - fetch file, parse data
3. **Extend PointCloudOctreeGeometry** with parsed data
4. **Return PointCloudOctree** for rendering
5. **Register loader** in Potree.js exports

---

## Backend API Endpoints

### GET /api/config

Returns platform configuration:

```json
{
  "isCloudEnabled": true,
  "azureContainer": "raw-las",
  "platform": "vercel"
}
```

### GET /api/list

Returns all uploaded projects:

```json
{
  "uploads": [
    {
      "name": "project1",
      "url": "https://blob.url/manifest.json?sas=token",
      "storageMode": "cloud"
    }
  ]
}
```

### POST /api/upload

Upload a point cloud file:

```
Content-Type: multipart/form-data
- file: <LAS/LAZ file>
- projectName: "My Project"
- storageMode: "local|cloud"
```

### GET /api/status/:id

Check conversion status:

```json
{
  "status": "converting|complete|failed",
  "progress": 0.75,
  "error": null
}
```

### POST /api/projects

Manage project metadata:

```json
{ "action": "rename|delete", "projectId": "...", ... }
```

---

## Deployment

### Local Development

```bash
npm start  # Node.js server on :3000
```

### Azure App Service

- Serves via IIS on Azure
- Full persistent storage (local filesystem)
- Handles file uploads and conversions
- Environment: NODE_ENV=production

### Vercel (Serverless)

- API routes only (no local file storage)
- Uses Azure Blob for data
- Automatic deployment from GitHub
- Scales horizontally with demand

### Environment Variables

**Required**:

```
AZURE_STORAGE_ACCOUNT=myaccount
AZURE_STORAGE_KEY=mykey
AZURE_STORAGE_CONTAINER=raw-las
```

**Optional**:

```
NODE_ENV=production|development
PORT=3000
DEBUG=potree:*
```

---

## Performance & Optimization

### Target Metrics

- **Frame Rate**: 60 fps (60 ms per frame)
- **Visible Points**: 2-4 million (tunable)
- **Load Time**: < 2 seconds to first interactive view
- **Memory**: < 1GB RAM for ~100M point clouds

### Optimization Tips

1. **Octree Quality**: Use `minimumNodePixelSize` to skip far-away nodes
2. **Point Budget**: Set `visiblePointsTarget` based on GPU capacity
3. **Material Complexity**: Simpler shaders = better performance
4. **Texture Size**: Reduce classification/elevation texture resolution
5. **Worker Pool**: Use web workers for decoding (`WorkerPool.js`)

---

## Debugging

### Browser Console

```javascript
// Access viewer instance
window.viewer;

// Check visible nodes
viewer.scene.activePointclouds[0].visibleNodes.length;

// Change point size
viewer.scene.activePointclouds[0].material.size = 2;

// Toggle bounding boxes
viewer.scene.activePointclouds[0].showBoundingBox = true;

// Get camera position
viewer.scene.getActiveCamera().position;
```

### Server Logs

```bash
# Enable debug output
DEBUG=potree:* npm start

# Watch for upload errors
tail -f server/logs/upload.log
```

### Performance Profiling

```javascript
// Enable Potree timing measurements
Potree.measureTimings = true;

// View performance metrics (frame time, point count)
// Check browser DevTools Performance tab
```

---

## Key Files for New Developers

**Must Read** (understand architecture):

- ✅ `src/Potree.js` - Module exports
- ✅ `src/PointCloudOctree.js` - Data structure
- ✅ `src/PotreeRenderer.js` - Rendering logic
- ✅ `public/app.js` - Frontend flow
- ✅ `server/index.js` - Backend setup

**Should Know** (common patterns):

- `src/viewer/viewer.js` - UI controller
- `src/EventDispatcher.js` - Event system
- `src/loader/*` - Loading different formats
- `src/materials/PointCloudMaterial.js` - GPU rendering
- `api/_lib/azure.js` - Cloud integration

**When You Need To**:

- Modify colors: `materials/ClassificationScheme.js`
- Add tools: `utils/*Tool.js`
- Change UI: `viewer/sidebar.js`
- Fix imports: `src/Potree.js`

---

## Contributing

### Code Style

- Use ES6+ syntax
- JSDoc comments for public methods
- Consistent indentation (tabs in most files, spaces in some)
- Meaningful variable names

### Documentation

- Add file-level comments explaining purpose
- Document class responsibilities
- Explain complex algorithms
- Include usage examples

### Testing

- Manual testing in browser (most common)
- Check console for warnings/errors
- Profile performance with DevTools
- Test on different browsers/devices

---

## Common Issues

### "WebGL context lost"

- Browser tab backgrounded
- Too many points rendered (reduce budget)
- GPU out of memory

### "Shader compilation failed"

- Check browser console for error
- Verify GLSL syntax
- Check uniform/attribute names

### "Point cloud not loading"

- Check browser Network tab (404 errors?)
- Verify manifest.json exists and is valid JSON
- Check CORS headers if cross-origin
- Look for SAS token expiration (cloud)

### "Performance dropping over time"

- Memory leak: Check developer tools Memory tab
- Verify nodes are being unloaded (check GC)
- Reduce point count or buffer size
- Close other browser tabs

---

## Resources

- **Three.js Documentation**: https://threejs.org/docs/
- **WebGL Specification**: https://www.khronos.org/webgl/
- **LAS Specification**: https://www.asprs.org/divisions-committees/lidar-division/laser-las-file-format-exchange-activities
- **Potree Repository**: https://github.com/potree/potree
- **Point Cloud Rendering Papers**: Search "octree rendering" or "LOD point clouds"

---

**Last Updated**: May 2026
**For Questions**: Consult code comments and this guide
