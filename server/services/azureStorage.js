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
        projects.push(project);
        fs.writeFileSync(config.azureProjectsFile, JSON.stringify(projects, null, 2));
    },

    removeAzureProject(id) {
        const projects = this.getAzureProjects().filter(p => p.name !== id);
        fs.writeFileSync(config.azureProjectsFile, JSON.stringify(projects, null, 2));
    }
};

module.exports = azureStorage;
