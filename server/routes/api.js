const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const azureStorage = require('../services/azureStorage');
const converter = require('../services/converter');
const blobUploader = require('../services/blobUploader');
const projectManager = require('../services/projectManager');

// Shared Job tracking
const jobs = new Map();

// Multer setup for local uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, config.uploadsDir);
    },
    filename: (req, file, cb) => {
        // Keep original name for layers, prefix with UUID for raw data
        if (req.path.includes('upload-layer')) {
            return cb(null, file.originalname);
        }
        cb(null, `${uuidv4()}-${file.originalname}`);
    }
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (req.path.includes('upload-layer')) {
            const allowed = ['.shp', '.dbf', '.shx', '.prj', '.kml', '.kmz', '.json', '.geojson'];
            if (allowed.includes(ext)) return cb(null, true);
            return cb(new Error('Layer type not supported'));
        }
        if (ext === '.las' || ext === '.laz') cb(null, true);
        else cb(new Error('Only .las and .laz supported'));
    }
});

// --- ROUTES ---

router.get('/config', (req, res) => {
    res.json({
        isCloudEnabled: config.azure.isCloudEnabled,
        azureContainer: config.azure.rawContainer
    });
});

router.get('/debug/converter', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    
    const converterPath = config.potreeConverterPath;
    const exists = fs.existsSync(converterPath);
    
    let stats = null;
    let isExecutable = false;
    let fileType = null;
    let errorMsg = null;
    
    if (exists) {
        try {
            stats = fs.statSync(converterPath);
            // Check if executable (mode & 0111)
            isExecutable = (stats.mode & parseInt('111', 8)) !== 0;
            
            // Try to get file type
            try {
                fileType = execSync(`file "${converterPath}"`, { encoding: 'utf8' }).trim();
            } catch (e) {
                fileType = 'Could not determine type';
            }
        } catch (e) {
            errorMsg = e.message;
        }
    }
    
    res.json({
        path: converterPath,
        exists,
        isExecutable,
        stats: stats ? {
            size: stats.size,
            mode: '0' + (stats.mode & parseInt('777', 8)).toString(8),
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory()
        } : null,
        fileType,
        errorMsg,
        platform: process.platform,
        cwd: process.cwd(),
        potreeRoot: path.dirname(path.dirname(converterPath))
    });
});

router.post('/upload', (req, res, next) => {
    upload.array('file', 500)(req, res, (err) => {
        if (err) {
            console.error('[Upload] Multer error:', err);
            const status = err.code === 'LIMIT_FILE_COUNT' ? 400 : 500;
            return res.status(status).json({
                error: err.code === 'LIMIT_FILE_COUNT'
                    ? 'Too many files. Maximum allowed is 500 per project.'
                    : `Upload failure: ${err.message}`
            });
        }
        next();
    });
}, (req, res) => {
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const jobId = uuidv4();
    const firstFile = files[0];
    const projectName = (req.body.projectName || path.parse(firstFile.originalname).name).trim();
    const existingProjectId = req.body.projectId || null;  // NEW: Support incremental uploads
    
    let projectId, batchPath, projectPath;
    
    try {
        // NEW: Use projectManager for batch-based storage
        const projectInfo = projectManager.initializeProject(projectName, existingProjectId);
        projectId = projectInfo.projectId;
        projectPath = projectInfo.projectPath;
        batchPath = projectInfo.batchPath;
    } catch (err) {
        console.error('[Upload] ProjectManager error:', err.message);
        return res.status(400).json({ error: err.message });
    }

    const batchOutputPath = path.join(batchPath, 'pointclouds');

    const job = {
        id: jobId,
        projectId: projectId,  // NEW: Track project
        status: 'processing',
        progress: 0,
        startTime: Date.now(),
        fileName: files.length > 1 ? `${firstFile.originalname} (+${files.length - 1} more)` : firstFile.originalname,
        fileCount: files.length,
        outputPath: `/pointclouds/converted/${projectId}/meta.json`  // NEW: Point to master metadata
    };
    jobs.set(jobId, job);

    const filePaths = files.map(f => f.path);
    console.log(`[Job ${jobId}] Starting conversion with ${files.length} file(s) for project ${projectId}`);
    
    converter.convert(filePaths, batchOutputPath, async (type, data) => {
        if (type === 'stdout' || type === 'stderr') {
            console.log(`[Job ${jobId}] ${type}: ${data}`);
            return;
        }
        
        if (type === 'close') {
            job.status = data === 0 ? 'completed' : 'failed';
            job.progress = data === 0 ? 100 : 0;
            if (data !== 0) job.error = `Exit code ${data}`;

            if (data === 0) {
                try {
                    // NEW: Generate master metadata after successful conversion
                    console.log(`[Job ${jobId}] Generating master metadata...`);
                    const masterMeta = projectManager.generateMasterMetadata(projectPath, projectId);
                    projectManager.saveMasterMetadata(projectPath, masterMeta);
                    job.batchCount = masterMeta.totalBatches;

                    // If cloud enabled, upload entire project (all batches) to blob storage
                    if (config.azure.isCloudEnabled) {
                        try {
                            console.log(`[Job ${jobId}] Starting cloud upload to Azure Blob Storage...`);
                            const cloudUrl = await blobUploader.uploadConvertedProject(
                                projectPath,
                                projectId  // Upload the entire project now
                            );
                            job.outputPath = cloudUrl;
                            job.storageMode = 'cloud';
                            job.cloudUploadStatus = 'success';
                            console.log(`[Job ${jobId}] Cloud upload successful: ${cloudUrl}`);
                        } catch (uploadErr) {
                            console.error(`[Job ${jobId}] Cloud upload failed:`, uploadErr.message);
                            job.warning = 'Conversion complete but cloud upload failed - file available locally';
                            job.cloudUploadStatus = 'failed';
                            job.cloudUploadError = uploadErr.message;
                        }
                    }
                } catch (metaErr) {
                    console.error(`[Job ${jobId}] Failed to generate master metadata:`, metaErr.message);
                    job.warning = 'Conversion successful but metadata generation failed';
                    job.metadataError = metaErr.message;
                }
            } else {
                console.error(`[Job ${jobId}] Conversion failed with exit code ${data}`);
            }

            // Log completion
            console.log(`[Job ${jobId}] Finished with status: ${job.status}`);
        } else if (type === 'error') {
            job.status = 'failed';
            job.error = data.message;
            console.error(`[Job ${jobId}] Error:`, data.message);
        }
    });

    res.json({ 
        jobId,
        projectId  // NEW: Return projectId so user can add more files
    });
});

router.get('/upload-sas', async (req, res) => {
    const fileName = req.query.fileName;
    
    if (!fileName) {
        return res.status(400).json({ error: 'fileName parameter required' });
    }

    try {
        console.log(`[SAS Upload] Generating SAS URL for: ${fileName}`);
        const result = await azureStorage.getUploadSas(fileName);
        console.log(`[SAS Upload] Success: ${result.blobName}`);
        res.json(result);
    } catch (err) {
        console.error(`[SAS Upload] Error:`, err.message);
        console.error(err.stack);
        res.status(500).json({ 
            error: err.message,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

router.post('/trigger-conversion-cloud', async (req, res) => {
    const { blobName, projectName } = req.body;
    if (!blobName) return res.status(400).json({ error: 'blobName required' });

    const jobId = uuidv4();
    const job = { id: jobId, status: 'processing', progress: 0, startTime: Date.now(), fileName: blobName, storageMode: 'cloud' };
    jobs.set(jobId, job);
    res.json({ jobId });

    try {
        const downloadPath = path.join(config.tempCloudDir, blobName);
        console.log(`[Job ${jobId}] Starting: downloading blob to ${downloadPath}`);
        await azureStorage.downloadBlob(blobName, downloadPath);
        console.log(`[Job ${jobId}] Blob downloaded successfully`);

        const outputDirName = (projectName || path.parse(blobName).name).replace(/\s+/g, '_') + '_' + jobId.substring(0, 8);
        const localOutputPath = path.join(config.tempCloudDir, outputDirName);
        console.log(`[Job ${jobId}] Starting conversion to: ${localOutputPath}`);

        converter.convert(downloadPath, localOutputPath, async (type, data) => {
            console.log(`[Job ${jobId}] Converter event: type=${type}, data=${data}`);
            
            if (type === 'stdout' || type === 'stderr') {
                console.log(`[Job ${jobId}] ${type}: ${data}`);
                return;
            }
            
            if (type === 'close' && data === 0) {
                try {
                    console.log(`[Job ${jobId}] Conversion successful, uploading to Azure...`);
                    await azureStorage.uploadDirectory(localOutputPath, outputDirName);
                    // Auto-detect the actual manifest file path
                    const cloudUrl = await azureStorage.resolveCloudManifestUrl(outputDirName);
                    azureStorage.saveAzureProject({ name: outputDirName, url: cloudUrl, type: 'pointcloud', storageMode: 'cloud' });
                    job.status = 'completed'; job.progress = 100; job.outputPath = cloudUrl;
                    console.log(`[Job ${jobId}] Completed successfully: ${cloudUrl}`);
                } catch (e) { 
                    job.status = 'failed'; 
                    job.error = e.message;
                    console.error(`[Job ${jobId}] Upload failed: ${e.message}`);
                }
            } else if (type === 'close') {
                job.status = 'failed'; 
                job.error = `Converter exited with ${data}`;
                console.error(`[Job ${jobId}] Conversion failed with exit code ${data}`);
            } else if (type === 'error') {
                job.status = 'failed'; 
                job.error = data.message;
                console.error(`[Job ${jobId}] Converter error: ${data.message}`);
            }

            if (type === 'close') {
                console.log(`[Job ${jobId}] Cleaning up temp files...`);
                fs.rm(downloadPath, { force: true }, () => { });
                fs.rm(localOutputPath, { recursive: true, force: true }, () => { });
            }
        });
    } catch (err) {
        job.status = 'failed'; 
        job.error = err.message;
        console.error(`[Job ${jobId}] Error: ${err.message}`, err);
    }
});

router.get('/status/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    job ? res.json(job) : res.status(404).json({ error: 'Job not found' });
});

router.get('/list', async (req, res) => {
    try {
        // ── Local projects ────────────────────────────────────────────────────
        let files = [];
        try {
            files = fs.readdirSync(config.convertedDir, { withFileTypes: true });
        } catch (e) {
            // convertedDir may not exist yet on fresh deployments
        }
        const local = (files || []).filter(d => d.isDirectory()).map(d => ({
            name: d.name,
            url: `/pointclouds/converted/${d.name}/index.html`,
            type: 'pointcloud',
            storageMode: 'local',
            source: 'local'
        }));

        // ── Cloud projects ────────────────────────────────────────────────────
        let cloud = [];
        if (config.azure.isCloudEnabled) {
            try {
                // 1. Dynamically discover projects from the blob container
                const blobProjects = await azureStorage.listBlobProjects();

                // 2. Load the static registry (azure_projects.json) — may contain
                //    extra metadata like layers that blob enumeration alone can't provide
                const registryProjects = azureStorage.getAzureProjects();
                const registryMap = new Map(registryProjects.map(p => [p.name, p]));

                // 3. Merge: registry entries take priority (preserve stored metadata);
                //    blob-only projects are added as new entries
                const mergedMap = new Map();
                for (const bp of blobProjects) {
                    mergedMap.set(bp.name, bp); // blob source as base
                }
                for (const rp of registryProjects) {
                    // Overlay registry data so layers, storageMode etc. are preserved
                    mergedMap.set(rp.name, { source: 'blob', ...mergedMap.get(rp.name), ...rp });
                }

                // 4. Attach fresh read SAS tokens to all cloud projects
                let sasToken = '';
                try {
                    sasToken = await azureStorage.getReadSasToken();
                } catch (sasErr) {
                    console.error('[API List] Failed to generate Read SAS:', sasErr.message);
                }

                let healed = false;
                const cloudEntries = await Promise.all(
                    Array.from(mergedMap.values()).map(async (p) => {
                        let url = p.url || '';
                        // Auto-heal: resolve actual manifest path if needed
                        if (url.includes('metadata.json') || !url) {
                            try {
                                const correctedUrl = await azureStorage.resolveCloudManifestUrl(p.name);
                                if (correctedUrl !== url.split('?')[0]) {
                                    console.log(`[API List] Auto-healed URL for ${p.name}: ${url} -> ${correctedUrl}`);
                                    url = correctedUrl;
                                    healed = true;
                                }
                            } catch (e) {
                                console.warn(`[API List] Could not resolve manifest for ${p.name}:`, e.message);
                            }
                        }
                        const baseUrl = url.split('?')[0];
                        return {
                            ...p,
                            url: sasToken ? `${baseUrl}?${sasToken}` : baseUrl,
                            storageMode: 'cloud'
                        };
                    })
                );
                cloud = cloudEntries;

                // 5. Persist any healed URLs back, but only for registry-tracked projects
                if (healed) {
                    const updatedRegistry = cloud
                        .filter(p => registryMap.has(p.name))
                        .map(p => ({ ...registryMap.get(p.name), url: p.url.split('?')[0] }));
                    if (updatedRegistry.length > 0) {
                        fs.writeFileSync(config.azureProjectsFile, JSON.stringify(updatedRegistry, null, 2));
                    }
                }
            } catch (cloudErr) {
                console.error('[API List] Cloud enumeration failed:', cloudErr.message);
                // Fall back to static registry only
                cloud = azureStorage.getAzureProjects().map(p => ({ ...p, storageMode: 'cloud' }));
            }
        }

        // ── Examples ──────────────────────────────────────────────────────────
        let examples = [];
        const exDir = path.join(__dirname, '../../examples');
        if (fs.existsSync(exDir)) {
            examples = fs.readdirSync(exDir).filter(f => f.endsWith('.html')).map(f => ({
                name: f, url: `/examples/${f}`, type: 'example'
            }));
        }

        res.json({
            uploads: [...local, ...cloud],
            examples,
            cloudProjectsCount: cloud.length,
            localProjectsCount: local.length
        });
    } catch (err) {
        console.error('[API List] Error:', err);
        res.status(500).json({ error: 'Failed to list projects' });
    }
});

router.delete('/delete/:id', async (req, res) => {
    const id = req.params.id;
    console.log(`[Delete] Request to delete project: ${id}`);

    const cloudProject = azureStorage.getAzureProjects().find(p => p.name === id);
    if (cloudProject) {
        try {
            if (config.azure.isCloudEnabled) await azureStorage.deleteProjectBlobs(id);
            azureStorage.removeAzureProject(id);
            return res.json({ success: true, mode: 'cloud' });
        } catch (e) {
            console.error(`[Delete] Cloud delete failed:`, e);
            return res.status(500).json({ error: e.message });
        }
    }

    const localPath = path.join(config.convertedDir, id);
    if (fs.existsSync(localPath)) {
        try {
            // Try to cleanup source data from uploads/
            // Check both common locations for sources.json
            const possibleSourcePaths = [
                path.join(localPath, 'pointclouds/index/sources.json'),
                path.join(localPath, 'sources.json')
            ];

            let sourcesData = null;
            for (const sp of possibleSourcePaths) {
                if (fs.existsSync(sp)) {
                    try {
                        sourcesData = JSON.parse(fs.readFileSync(sp, 'utf8'));
                        break;
                    } catch (e) {
                        console.warn(`[Delete] Failed to parse sources.json at ${sp}`);
                    }
                }
            }

            if (sourcesData && sourcesData.sources && Array.isArray(sourcesData.sources)) {
                for (const s of sourcesData.sources) {
                    const sourceFile = path.join(config.uploadsDir, s.name);
                    if (fs.existsSync(sourceFile)) {
                        console.log(`[Delete] Cleaning up raw source file: ${s.name}`);
                        try {
                            fs.unlinkSync(sourceFile);
                        } catch (unlinkErr) {
                            console.error(`[Delete] Failed to unlink source file ${sourceFile}:`, unlinkErr);
                        }
                    }
                }
            }

            // Delete the converted visualization directory
            await fs.promises.rm(localPath, { recursive: true, force: true });
            console.log(`[Delete] Successfully deleted local directory: ${localPath}`);

            res.json({ success: true, mode: 'local' });
        } catch (err) {
            console.error(`[Delete] Error during local deletion:`, err);
            res.status(500).json({ error: 'Delete failed: ' + err.message });
        }
    } else {
        res.status(404).json({ error: 'Project not found' });
    }
});

router.post('/upload-layer', (req, res, next) => {
    upload.array('files', 10)(req, res, (err) => {
        if (err) {
            console.error('[LayerUpload] Multer error:', err);
            return res.status(400).json({ error: `Upload rejection: ${err.message}` });
        }
        next();
    });
}, async (req, res) => {
    const projectId = req.body.projectId || req.query.projectId || 'standalone';
    const files = req.files || [];

    console.log(`[LayerUpload] Incoming request. Project: ${projectId}, Files: ${files.length}`);

    if (!files || files.length === 0) {
        console.warn('[LayerUpload] No files found in request');
        return res.status(400).json({ error: 'No files uploaded' });
    }

    // Identify primary file (.shp or .kml)
    const primaryFile = files.find(f => {
        const fn = f.originalname.toLowerCase();
        return fn.endsWith('.shp') || fn.endsWith('.kml');
    });

    if (!primaryFile) {
        console.warn('[LayerUpload] No primary .shp or .kml file found among uploaded files:', files.map(f => f.originalname));
        return res.status(400).json({ error: 'Missing primary layer file (.shp or .kml)' });
    }

    const type = primaryFile.originalname.toLowerCase().endsWith('.shp') ? 'SHP' : 'KML';
    let responseData = { success: true, type, files: files.map(f => f.originalname) };

    try {
        const cloudProject = azureStorage.getAzureProjects().find(p => p.name === projectId);

        if (cloudProject && config.azure.isCloudEnabled) {
            // Upload to Azure
            const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.convertedContainer);
            for (const file of files) {
                const blobName = `${projectId}/layers/${file.originalname}`;
                const blockBlobClient = containerClient.getBlockBlobClient(blobName);
                await blockBlobClient.uploadFile(file.path);
                // Cleanup local temp file
                fs.unlinkSync(file.path);
            }
            const primaryUrl = `https://${config.azure.accountName}.blob.core.windows.net/${config.azure.convertedContainer}/${projectId}/layers/${primaryFile.originalname}`;
            responseData.primaryUrl = primaryUrl;

            // Update cloud manifest metadata
            cloudProject.layers = cloudProject.layers || [];
            if (!cloudProject.layers.find(l => l.name === primaryFile.originalname)) {
                cloudProject.layers.push({ name: primaryFile.originalname, url: primaryUrl, type });
                // We need to persist changes back to azure_projects.json
                const allProjects = azureStorage.getAzureProjects().map(p => p.name === projectId ? cloudProject : p);
                fs.writeFileSync(config.azureProjectsFile, JSON.stringify(allProjects, null, 2));
            }
        } else {
            // Local project
            console.log(`[LayerUpload] Processing local project: "${projectId}"`);
            const projectDir = path.join(config.convertedDir, projectId, 'layers');

            try {
                if (!fs.existsSync(projectDir)) {
                    console.log(`[LayerUpload] Creating project layers directory: ${projectDir}`);
                    fs.mkdirSync(projectDir, { recursive: true });
                }
            } catch (dirErr) {
                console.error(`[LayerUpload] Directory creation failed for ${projectDir}:`, dirErr);
                throw new Error(`Failed to create layers directory: ${dirErr.message}`);
            }

            for (const file of files) {
                const destPath = path.join(projectDir, file.originalname);
                console.log(`[LayerUpload] Moving file: ${file.originalname} -> ${destPath}`);

                try {
                    // Safe move across partitions (copy + unlink)
                    fs.copyFileSync(file.path, destPath);
                    fs.unlinkSync(file.path);
                    console.log(`[LayerUpload] Successfully moved ${file.originalname}`);
                } catch (moveErr) {
                    console.error(`[LayerUpload] Critical move failure for ${file.originalname}:`, moveErr);
                    // Attempt to proceed if at least primary file moved, but this is bad
                }
            }

            const primaryUrl = `/pointclouds/converted/${projectId}/layers/${encodeURIComponent(primaryFile.originalname)}`;
            responseData.primaryUrl = primaryUrl;
            console.log(`[LayerUpload] Local upload complete. Primary URL: ${primaryUrl}`);

            // Save back-reference with ORIGINAL name for readability in manifest
            if (projectId && projectId !== 'standalone') {
                const manifestPath = path.join(config.convertedDir, projectId, 'layers.json');
                let layers = [];
                if (fs.existsSync(manifestPath)) {
                    try {
                        const content = fs.readFileSync(manifestPath, 'utf8');
                        layers = JSON.parse(content);
                    } catch (e) { console.error(`[LayerUpload] Failed to parse manifest at ${manifestPath}:`, e); }
                }

                if (!layers.find(l => l.name === primaryFile.originalname)) {
                    layers.push({ name: primaryFile.originalname, url: primaryUrl, type });
                    fs.writeFileSync(manifestPath, JSON.stringify(layers, null, 2));
                    console.log(`[LayerUpload] Manifest updated successfully: ${manifestPath}`);
                }
            }
        }

        res.json(responseData);
    } catch (err) {
        console.error('Layer upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/project-layers/:id', (req, res) => {
    const id = req.params.id;
    const cloudProject = azureStorage.getAzureProjects().find(p => p.name === id);
    if (cloudProject) {
        return res.json(cloudProject.layers || []);
    }

    const manifestPath = path.join(config.convertedDir, id, 'layers.json');
    const layersDir = path.join(config.convertedDir, id, 'layers');

    if (!fs.existsSync(manifestPath)) return res.json([]);

    let layers;
    try { layers = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { return res.json([]); }

    // Self-heal: for each layer in manifest, verify the file exists at its URL.
    // If not (e.g. stale UUID-prefix), scan the layers dir for a file matching the original name.
    let changed = false;
    if (fs.existsSync(layersDir)) {
        const diskFiles = fs.readdirSync(layersDir);
        layers = layers.map(layer => {
            const baseUrl = layer.url.split('/').pop(); // filename part of URL
            const diskPath = path.join(layersDir, baseUrl);
            if (fs.existsSync(diskPath)) return layer; // URL is valid, keep as-is

            // File doesn't exist at stored URL — find by original name
            const originalName = layer.name;
            const found = diskFiles.find(f => f === originalName || f.endsWith('-' + originalName));
            if (found) {
                const newUrl = `/pointclouds/converted/${id}/layers/${found}`;
                console.log(`[Layers] Healing stale URL for ${originalName}: ${layer.url} -> ${newUrl}`);
                changed = true;
                return { ...layer, url: newUrl };
            }
            console.warn(`[Layers] Layer file missing on disk: ${originalName}`);
            return null; // will be filtered out
        }).filter(Boolean);
    }

    if (changed) {
        try { fs.writeFileSync(manifestPath, JSON.stringify(layers, null, 2)); }
        catch (e) { console.error('Failed to update layers.json:', e); }
    }

    res.json(layers);
});

// ─── NEW PROJECT MANAGEMENT ENDPOINTS ──────────────────────────────

/**
 * GET /api/projects
 * List all existing projects with metadata
 * Supports incremental upload workflow
 */
router.get('/projects', (req, res) => {
    try {
        const projects = projectManager.getAllProjects();
        console.log(`[API] Listed ${projects.length} project(s)`);
        res.json(projects);
    } catch (err) {
        console.error('[API] Error listing projects:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/projects/:projectId
 * Get detailed information about a specific project
 * Shows all batches and their metadata
 */
router.get('/projects/:projectId', (req, res) => {
    try {
        const project = projectManager.getProjectDetails(req.params.projectId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        console.log(`[API] Retrieved details for project: ${req.params.projectId}`);
        res.json(project);
    } catch (err) {
        console.error('[API] Error retrieving project:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
