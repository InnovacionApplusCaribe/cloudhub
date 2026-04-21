const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Service to manage multi-batch (incremental) point cloud projects
 */
class ProjectManager {
    constructor() {
        this.convertedDir = config.convertedDir;
    }

    /**
     * Prepares a project directory and a new batch directory for upload
     * @param {string} projectName - Human readable name
     * @param {string} [existingProjectId] - ID of project to add to
     * @returns {Object} { projectId, projectPath, batchId, batchPath }
     */
    initializeProject(projectName, existingProjectId) {
        // 1. Determine Project ID (slugify name or use existing)
        let projectId = existingProjectId;
        if (!projectId) {
            projectId = projectName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
            // If project with this ID already exists, we might want to append a suffix 
            // but the MD says "Stable project ID", so we'll just use it.
            // If the user wants a new project with same name, they should probably
            // have a way to specify a new ID, but for now we follow the "Static ID" rule.
        }

        const projectPath = path.join(this.convertedDir, projectId);
        if (!fs.existsSync(projectPath)) {
            fs.mkdirSync(projectPath, { recursive: true });
        }

        // 2. Determine Next Batch ID (batch_001, batch_002, etc.)
        const files = fs.readdirSync(projectPath, { withFileTypes: true });
        const batchDirs = files
            .filter(f => f.isDirectory() && f.name.startsWith('batch_'))
            .map(f => f.name);

        let nextBatchNum = 1;
        if (batchDirs.length > 0) {
            const nums = batchDirs.map(name => parseInt(name.split('_')[1])).filter(n => !isNaN(n));
            if (nums.length > 0) {
                nextBatchNum = Math.max(...nums) + 1;
            }
        }
        const batchId = `batch_${nextBatchNum.toString().padStart(3, '0')}`;
        const batchPath = path.join(projectPath, batchId);

        if (!fs.existsSync(batchPath)) {
            fs.mkdirSync(batchPath, { recursive: true });
        }

        return { projectId, projectPath, batchId, batchPath };
    }

    /**
     * Generates a master meta.json that references all batches in a project
     * @param {string} projectPath 
     * @param {string} projectId 
     * @returns {Object} Master metadata object
     */
    generateMasterMetadata(projectPath, projectId) {
        const files = fs.readdirSync(projectPath, { withFileTypes: true });
        const batchDirs = files
            .filter(f => f.isDirectory() && f.name.startsWith('batch_'))
            .sort((a, b) => a.name.localeCompare(b.name));

        const batches = batchDirs.map(dir => {
            const batchId = dir.name;
            const metaPath = path.join(projectPath, batchId, 'metadata.json');
            let created = new Date();

            if (fs.existsSync(metaPath)) {
                try {
                    const stats = fs.statSync(metaPath);
                    created = stats.birthtime;
                } catch (e) {
                    console.error(`Error reading stats for ${metaPath}:`, e.message);
                }
            }

            return {
                id: batchId,
                created: created.toISOString(),
                url: `./${batchId}/metadata.json`
            };
        });

        return {
            id: projectId,
            name: projectId,
            created: batches.length > 0 ? batches[0].created : new Date().toISOString(),
            updated: new Date().toISOString(),
            batches: batches,
            totalBatches: batches.length,
            batchUrls: batches.map(b => b.url)
        };
    }

    /**
     * Saves the master metadata to meta.json
     * @param {string} projectPath 
     * @param {Object} masterMeta 
     */
    saveMasterMetadata(projectPath, masterMeta) {
        const metaPath = path.join(projectPath, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify(masterMeta, null, 2));
    }

    /**
     * Gets all projects (hybrid: new multi-batch and old single-batch)
     * @returns {Array} List of projects
     */
    getAllProjects() {
        if (!fs.existsSync(this.convertedDir)) return [];

        const dirs = fs.readdirSync(this.convertedDir, { withFileTypes: true })
            .filter(d => d.isDirectory());

        return dirs.map(d => {
            const projectId = d.name;
            const projectPath = path.join(this.convertedDir, projectId);
            const metaPath = path.join(projectPath, 'meta.json');

            if (fs.existsSync(metaPath)) {
                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    return {
                        id: projectId,
                        name: meta.name || projectId,
                        created: meta.created,
                        updated: meta.updated,
                        batchCount: meta.totalBatches || meta.batches.length,
                        url: `/pointclouds/converted/${projectId}/meta.json`,
                        type: 'pointcloud',
                        storageMode: 'local'
                    };
                } catch (e) {
                    console.error(`Error parsing meta.json for ${projectId}:`, e.message);
                }
            }

            // Fallback for old projects or projects without meta.json yet
            const stats = fs.statSync(projectPath);
            return {
                id: projectId,
                name: projectId,
                created: stats.birthtime.toISOString(),
                updated: stats.mtime.toISOString(),
                batchCount: 1,
                url: `/pointclouds/converted/${projectId}/metadata.json`,
                type: 'pointcloud',
                storageMode: 'local'
            };
        });
    }

    /**
     * Gets detailed info for a project
     * @param {string} projectId 
     * @returns {Object|null} Project details
     */
    getProjectDetails(projectId) {
        const projectPath = path.join(this.convertedDir, projectId);
        const metaPath = path.join(projectPath, 'meta.json');

        if (fs.existsSync(metaPath)) {
            try {
                return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            } catch (e) {
                console.error(`Error parsing meta.json for ${projectId}:`, e.message);
            }
        }

        // Return a virtual single-batch project for old ones
        if (fs.existsSync(projectPath)) {
            const stats = fs.statSync(projectPath);
            return {
                id: projectId,
                name: projectId,
                created: stats.birthtime.toISOString(),
                updated: stats.mtime.toISOString(),
                batches: [{
                    id: 'default',
                    created: stats.birthtime.toISOString(),
                    url: './metadata.json'
                }],
                totalBatches: 1,
                batchUrls: ['./metadata.json']
            };
        }

        return null;
    }
}

module.exports = new ProjectManager();
