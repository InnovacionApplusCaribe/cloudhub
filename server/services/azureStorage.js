const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const config = require('../config');
const { v4: uuidv4 } = require('uuid');

const azureStorage = {
    async getUploadSas(fileName) {
        if (!config.azure.isCloudEnabled) throw new Error('Cloud storage not enabled');

        const blobName = `${uuidv4()}-${fileName}`;
        const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.rawContainer);
        
        // Create container if it doesn't exist (private access by default)
        try {
            await containerClient.createIfNotExists();
        } catch (err) {
            // Container might already exist, that's fine
            if (err.code !== 'ContainerAlreadyExists') {
                throw err;
            }
        }

        const blobClient = containerClient.getBlobClient(blobName);

        // Extract account key and name from connection string for SAS generation
        const connStr = config.azure.connectionString;
        const accountKeyMatch = connStr.match(/AccountKey=([^;]+)/);
        const accountNameMatch = connStr.match(/AccountName=([^;]+)/);
        
        if (!accountKeyMatch || !accountNameMatch) {
            throw new Error('Could not extract account key or name from connection string');
        }

        const accountKey = accountKeyMatch[1];
        const accountName = accountNameMatch[1];

        const sasOptions = {
            containerName: config.azure.rawContainer,
            blobName: blobName,
            permissions: BlobSASPermissions.parse("racwd"),
            startsOn: new Date(),
            expiresOn: new Date(new Date().valueOf() + 3600 * 1000)
        };

        // Use the account key directly to generate SAS token
        const { StorageSharedKeyCredential } = require('@azure/storage-blob');
        const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
        const sasToken = generateBlobSASQueryParameters(sasOptions, sharedKeyCredential).toString();
        
        return {
            uploadUrl: `${blobClient.url}?${sasToken}`,
            blobName
        };
    },

    async downloadBlob(blobName, downloadPath) {
        const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.rawContainer);
        const blobClient = containerClient.getBlobClient(blobName);
        await blobClient.downloadToFile(downloadPath);
    },

    async uploadDirectory(localPath, azurePrefix) {
        const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.convertedContainer);
        
        // Create container if it doesn't exist (private access by default)
        try {
            await containerClient.createIfNotExists();
        } catch (err) {
            // Container might already exist, that's fine
            if (err.code !== 'ContainerAlreadyExists') {
                throw err;
            }
        }

        const uploadRecursive = async (currentLocalPath, currentAzurePrefix) => {
            const items = fs.readdirSync(currentLocalPath, { withFileTypes: true });
            for (const item of items) {
                const fullLocalPath = path.join(currentLocalPath, item.name);
                const fullAzurePath = currentAzurePrefix + '/' + item.name;

                if (item.isDirectory()) {
                    await uploadRecursive(fullLocalPath, fullAzurePath);
                } else {
                    const blockBlobClient = containerClient.getBlockBlobClient(fullAzurePath);
                    await blockBlobClient.uploadFile(fullLocalPath);
                }
            }
        };

        await uploadRecursive(localPath, azurePrefix);
    },

    async deleteProjectBlobs(projectId) {
        const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.convertedContainer);
        const blobs = containerClient.listBlobsFlat({ prefix: projectId });
        for await (const blob of blobs) {
            await containerClient.deleteBlob(blob.name);
        }
    },

    /**
     * Dynamically enumerate all point cloud projects stored in the Azure
     * converted-potree blob container.
     *
     * Strategy: List top-level folders (prefixes) and assume they are projects.
     * This is MUCH faster than listBlobsFlat() which would iterate over every
     * single file in every project.
     */
    async listBlobProjects() {
        if (!config.azure.isCloudEnabled) return [];

        const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.convertedContainer);
        const baseUrl = `https://${config.azure.accountName}.blob.core.windows.net/${config.azure.convertedContainer}`;

        const projects = [];

        try {
            // Use hierarchy listing with '/' delimiter to only see the top-level "folders"
            for await (const item of containerClient.listBlobsByHierarchy('/')) {
                if (item.kind === 'prefix') {
                    // prefix is like "project_name/"
                    const projectName = item.name.replace(/\/$/, '');
                    
                    // We default to metadata.json (Potree 2.0) as it's the modern standard.
                    // api.js will "auto-heal" if it needs to probe deeper, but we'll 
                    // minimize that by providing a sensible default.
                    projects.push({
                        name: projectName,
                        url: `${baseUrl}/${projectName}/metadata.json`,
                        type: 'pointcloud',
                        storageMode: 'cloud',
                        source: 'blob'
                    });
                }
            }
        } catch (err) {
            console.error('[AzureStorage] listBlobProjects error:', err.message);
            return [];
        }

        console.log(`[AzureStorage] listBlobProjects discovered ${projects.length} prefix(es) in container "${config.azure.convertedContainer}"`);
        return projects;
    },
    /**
     * Auto-detect the actual point cloud manifest URL for a project in Azure.
     * PotreeConverter v1.x outputs pointclouds/index/cloud.js
     * PotreeConverter v2.0 outputs metadata.json at root
     * This function probes the blob container to find the correct path.
     */
    async resolveCloudManifestUrl(projectName) {
        if (!config.azure.isCloudEnabled) {
            return `https://${config.azure.accountName}.blob.core.windows.net/${config.azure.convertedContainer}/${projectName}/metadata.json`;
        }

        const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.convertedContainer);
        const baseUrl = `https://${config.azure.accountName}.blob.core.windows.net/${config.azure.convertedContainer}`;

        // Probe possible manifest paths in priority order
        const candidates = [
            `${projectName}/metadata.json`,                        // Potree 2.0 root
            `${projectName}/pointclouds/index/metadata.json`,      // Potree 2.0 nested
            `${projectName}/pointclouds/index/cloud.js`,           // Potree 1.x nested
            `${projectName}/cloud.js`,                              // Potree 1.x root
        ];

        for (const candidate of candidates) {
            try {
                const blobClient = containerClient.getBlobClient(candidate);
                const exists = await blobClient.exists();
                if (exists) {
                    console.log(`[AzureStorage] Resolved manifest for ${projectName}: ${candidate}`);
                    return `${baseUrl}/${candidate}`;
                }
            } catch (e) {
                // Skip and try next
            }
        }

        // Fallback — return the metadata.json path even if not found
        console.warn(`[AzureStorage] No manifest found for ${projectName}, using default metadata.json path`);
        return `${baseUrl}/${projectName}/metadata.json`;
    },

    async getReadSasToken() {
        if (!config.azure.isCloudEnabled) return '';

        // Extract account key and name from connection string
        const connStr = config.azure.connectionString;
        const accountKeyMatch = connStr.match(/AccountKey=([^;]+)/);
        const accountNameMatch = connStr.match(/AccountName=([^;]+)/);
        
        if (!accountKeyMatch || !accountNameMatch) {
            throw new Error('Could not extract account key or name from connection string');
        }

        const accountKey = accountKeyMatch[1];
        const accountName = accountNameMatch[1];

        const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
        const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);

        const sasOptions = {
            containerName: config.azure.convertedContainer,
            permissions: BlobSASPermissions.parse("r"), // Read only
            startsOn: new Date(),
            expiresOn: new Date(new Date().valueOf() + 24 * 3600 * 1000) // 24 hours
        };

        const sasToken = generateBlobSASQueryParameters(sasOptions, sharedKeyCredential).toString();
        return sasToken;
    },

    getAzureProjects() {

        if (!fs.existsSync(config.azureProjectsFile)) return [];
        try {
            return JSON.parse(fs.readFileSync(config.azureProjectsFile, 'utf8'));
        } catch (e) {
            return [];
        }
    },

    saveAzureProject(project) {
        const projects = this.getAzureProjects();
        const index = projects.findIndex(p => p.name === project.name);
        if (index >= 0) {
            // Update existing
            projects[index] = { ...projects[index], ...project };
        } else {
            // Add new
            projects.push(project);
        }
        fs.writeFileSync(config.azureProjectsFile, JSON.stringify(projects, null, 2));
    },

    removeAzureProject(id) {
        const projects = this.getAzureProjects().filter(p => p.name !== id);
        fs.writeFileSync(config.azureProjectsFile, JSON.stringify(projects, null, 2));
    },

    /**
     * Fetch the layers.json manifest from the project's folder in Azure Blob Storage.
     * This ensures layer persistence even if the local registry is lost.
     */
    async getProjectLayers(projectId) {
        if (!config.azure.isCloudEnabled) return [];
        
        const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.convertedContainer);
        const blobName = `${projectId}/layers.json`;
        const blobClient = containerClient.getBlobClient(blobName);

        try {
            const exists = await blobClient.exists();
            if (!exists) return [];

            const downloadResponse = await blobClient.download();
            const content = await this.streamToString(downloadResponse.readableStreamBody);
            return JSON.parse(content);
        } catch (err) {
            console.error(`[AzureStorage] Failed to fetch layers.json for ${projectId}:`, err.message);
            return [];
        }
    },

    /**
     * Upload the layers.json manifest to the project's folder in Azure Blob Storage.
     */
    async saveProjectLayers(projectId, layers) {
        if (!config.azure.isCloudEnabled) return;

        const containerClient = config.azure.blobServiceClient.getContainerClient(config.azure.convertedContainer);
        const blobName = `${projectId}/layers.json`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        try {
            const content = JSON.stringify(layers, null, 2);
            await blockBlobClient.upload(content, content.length);
            console.log(`[AzureStorage] Successfully saved layers.json to cloud for project: ${projectId}`);
        } catch (err) {
            console.error(`[AzureStorage] Failed to save layers.json for ${projectId}:`, err.message);
            throw err;
        }
    },

    /**
     * Helper to convert a readable stream to a string.
     */
    async streamToString(readableStream) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            readableStream.on("data", (data) => {
                chunks.push(data.toString());
            });
            readableStream.on("end", () => {
                resolve(chunks.join(""));
            });
            readableStream.on("error", reject);
        });
    }
};

module.exports = azureStorage;
