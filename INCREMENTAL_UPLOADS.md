# Incremental Uploads Implementation Guide

## ✅ What's Changed

This implementation enables **incremental uploads** to existing projects, allowing you to add point clouds over time to the same 3D viewer without recreating the project.

---

## 🏗️ Architecture Changes

### 1. **Project Directory Structure**

**Before (Old):**

```
data/converted/
├── project_a1b2c3d4/        ← jobId suffix changes each upload
│   ├── metadata.json
│   ├── pointclouds/index/
```

**After (New):**

```
data/converted/
├── my_project/              ← Stable project ID
│   ├── meta.json           ← Master metadata (aggregates all batches)
│   ├── batch_001/          ← First upload
│   │   ├── metadata.json
│   │   ├── pointclouds/index/
│   ├── batch_002/          ← Second upload (NEW)
│   │   ├── metadata.json
│   │   ├── pointclouds/index/
│   ├── batch_003/          ← Third upload (NEW)
│   │   └── ...
```

### 2. **Key Components**

#### New Files Created:

- `server/services/projectManager.js` - Project lifecycle management
- `public/incremental-loader.js` - Client-side batch loader

#### Modified Files:

- `server/routes/api.js` - Updated `/upload` endpoint + new project endpoints
- `public/viewer.html` - Uses new incremental loader

---

## 🚀 How to Use - Frontend Flow

### **Upload #1 - Create New Project**

```javascript
POST /api/upload
{
  "projectName": "My Site Survey",
  "files": [site_001.las, site_002.las, ...]
}

Response:
{
  "jobId": "job-123",
  "projectId": "My_Site_Survey"  ← Save this!
}
```

**Result:** Creates `/data/converted/My_Site_Survey/batch_001/...`

---

### **Upload #2 - Add to Existing Project**

```javascript
POST /api/upload
{
  "projectName": "My Site Survey",    // Doesn't matter - projectId is used
  "projectId": "My_Site_Survey",       // ← The key parameter!
  "files": [site_003.las, site_004.las]
}

Response:
{
  "jobId": "job-456",
  "projectId": "My_Site_Survey"
}
```

**Result:** Creates `/data/converted/My_Site_Survey/batch_002/...`

- All batches are automatically aggregated in `meta.json`
- Viewer sees both batches as one unified project

---

### **Upload #3+ - Continue Adding**

Repeat the same process with the same `projectId`. Each upload creates a new batch.

---

## 📡 New API Endpoints

### **List All Projects**

```
GET /api/projects

Response:
[
  {
    "id": "My_Site_Survey",
    "name": "My_Site_Survey",
    "created": "2025-01-15T10:00:00Z",
    "updated": "2025-01-15T11:30:00Z",
    "batchCount": 3,
    "url": "/pointclouds/converted/My_Site_Survey/meta.json"
  },
  { ... }
]
```

### **Get Project Details**

```
GET /api/projects/My_Site_Survey

Response:
{
  "id": "My_Site_Survey",
  "name": "My_Site_Survey",
  "created": "2025-01-15T10:00:00Z",
  "updated": "2025-01-15T11:30:00Z",
  "batches": [
    {
      "id": "batch_001",
      "created": "2025-01-15T10:00:00Z",
      "url": "./batch_001/metadata.json"
    },
    {
      "id": "batch_002",
      "created": "2025-01-15T11:00:00Z",
      "url": "./batch_002/metadata.json"
    }
  ],
  "totalBatches": 2,
  "batchUrls": ["./batch_001/metadata.json", "./batch_002/metadata.json"]
}
```

---

## 👁️ Viewer Experience

### **Old Behavior (Single Upload)**

- User uploads LAS files → Creates project → Viewer loads single metadata.json
- To add more data: Must create new project

### **New Behavior (Incremental)**

- **Upload #1:** Creates project, displays batch 1
- **Upload #2:** Adds to same project, viewer auto-loads all batches
- **Upload #3+:** Continues accumulating - viewer shows all batches together

The `IncrementalLoader` class (in `incremental-loader.js`):

1. Detects if project has `meta.json` (master metadata)
2. Loads all batches listed in master metadata
3. Adds each batch as a separate point cloud to the 3D scene
4. Auto-fits camera to show all batches
5. Falls back to single-batch loading for compatibility

---

## 🔄 Master Metadata Structure

**`meta.json` example:**

```json
{
  "name": "My_Site_Survey",
  "created": "2025-01-15T10:00:00Z",
  "updated": "2025-01-15T11:30:00Z",
  "batches": [
    {
      "id": "batch_1704067200000_a1b2c3d4",
      "created": "2025-01-15T10:00:00Z",
      "url": "./batch_1704067200000_a1b2c3d4/metadata.json"
    },
    {
      "id": "batch_1704070800000_e5f6g7h8",
      "created": "2025-01-15T11:00:00Z",
      "url": "./batch_1704070800000_e5f6g7h8/metadata.json"
    }
  ],
  "totalBatches": 2,
  "batchUrls": [
    "./batch_1704067200000_a1b2c3d4/metadata.json",
    "./batch_1704070800000_e5f6g7h8/metadata.json"
  ]
}
```

**Auto-generated after each conversion.**

---

## ☁️ Cloud Deployment (Vercel/Railway/Azure)

### Azure Connection

The system **automatically uploads the entire project** (all batches) to Azure Blob Storage after each upload:

```
Before Upload #2:
blob.core.windows.net/cloudhub-converter/My_Site_Survey/
├── meta.json
├── batch_001/metadata.json
├── batch_001/pointclouds/...

After Upload #2:
blob.core.windows.net/cloudhub-converter/My_Site_Survey/
├── meta.json                       ← Updated
├── batch_001/metadata.json         ← Existing
├── batch_001/pointclouds/...
├── batch_002/metadata.json         ← NEW
├── batch_002/pointclouds/...
```

**Key Benefit:** Projects synced across all three deployments (Vercel, Railway, Azure).

---

## 🛠️ Implementation Details

### ProjectManager Service

**Location:** `server/services/projectManager.js`

```javascript
// Initialize project (new or existing)
const projectInfo = projectManager.initializeProject(
  projectName,
  existingProjectId,
);
// Returns: { projectId, projectPath, batchId, batchPath }

// Generate master metadata after conversion
const masterMeta = projectManager.generateMasterMetadata(
  projectPath,
  projectId,
);

// Get all projects
const projects = projectManager.getAllProjects();

// Get project details
const project = projectManager.getProjectDetails(projectId);
```

### Modified Upload Endpoint

**Location:** `server/routes/api.js` - `/upload` route

**New Parameters:**

- `projectId` (optional): Reuse existing project

**New Response Fields:**

- `projectId`: Project identifier (save for future uploads)

**New Logic:**

1. Accept `projectId` from request body
2. Use `projectManager.initializeProject()` to setup batch
3. Convert LAS files to batch subdirectory
4. Generate master metadata
5. Upload entire project to Azure (not just one batch)

---

## 🔗 Frontend Integration Example

### Upload Component

```javascript
// First upload - create project
const formData = new FormData();
formData.append("projectName", "Site Survey 2025");
formData.append("file", lasFile);

const response1 = await fetch("/api/upload", {
  method: "POST",
  body: formData,
});

const data1 = await response1.json();
const projectId = data1.projectId; // Save this!
console.log("Created project:", projectId);

// ... later, second upload ...

// Second upload - add to existing project
const formData2 = new FormData();
formData2.append("projectName", "Site Survey 2025");
formData2.append("projectId", projectId); // Reuse project!
formData2.append("file", newLasFile);

const response2 = await fetch("/api/upload", {
  method: "POST",
  body: formData2,
});

const data2 = await response2.json();
console.log("Added to project:", data2.projectId);
```

### Viewer Loading

```javascript
// Automatically loads all batches from meta.json
const projectPath = "/pointclouds/converted/Site_Survey_2025/";
const loader = new IncrementalLoader(viewer);

loader.loadProject(projectPath, (progress) => {
  console.log(`Loaded ${progress.loadedCount} batches...`);
});
```

---

## 🚀 Deployment Steps

### 1. **Push Code Changes**

```bash
git add .
git commit -m "Implement incremental uploads with batch-based storage"
git push origin main
```

### 2. **Vercel/Railway Auto-Deploy**

- Changes auto-deploy to Vercel and Railway
- New endpoints immediately available: `/api/projects`, `/api/projects/:projectId`

### 3. **Test Incremental Upload**

```bash
# First upload
curl -X POST http://localhost:3000/api/upload \
  -F "projectName=Test" \
  -F "file=@file1.las"

# Note the projectId in response

# Second upload
curl -X POST http://localhost:3000/api/upload \
  -F "projectName=Test" \
  -F "projectId=Test" \
  -F "file=@file2.las"
```

---

## ✨ Benefits

✅ **Same Project, Multiple Uploads** - No need to create new projects  
✅ **Persistent Project IDs** - Easy to reference and extend  
✅ **Automatic Aggregation** - Master metadata ties batches together  
✅ **Multi-Cloud Sync** - All batches uploaded to Azure automatically  
✅ **Viewer Integration** - Displays all batches as one unified scene  
✅ **Backwards Compatible** - Old single-batch projects still work  
✅ **Scalable** - Unlimited batches per project

---

## 📝 Migration Notes

### Existing Projects

Old projects (with jobId suffix like `project_a1b2c3d4`) continue to work:

- Viewer detects they have no `meta.json`
- Falls back to loading single batch
- Can be migrated incrementally as needed

### Future Enhancement

Optional: Create migration script to rename old projects to new format

---

## 🐛 Troubleshooting

| Issue                         | Solution                                                    |
| ----------------------------- | ----------------------------------------------------------- |
| `projectId` not returned      | Ensure API response includes it. Check server logs.         |
| Batches not showing in viewer | Verify `meta.json` exists and lists all batches.            |
| Azure sync failing            | Check Azure credentials in env variables.                   |
| Viewer shows old data         | Clear browser cache. Check blob storage for latest version. |

---

## 📚 Related Files

- `server/services/projectManager.js` - Project management logic
- `server/routes/api.js` - Upload and project endpoints
- `public/incremental-loader.js` - Batch loading client code
- `public/viewer.html` - Updated viewer with loader integration
