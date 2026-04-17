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
        await containerClient.createIfNotExists({ access: 'blob' });

        const blobClient = containerClient.getBlobClient(blobName);

        const sasOptions = {
            containerName: config.azure.rawContainer,
            blobName: blobName,
            permissions: BlobSASPermissions.parse("racwd"),
            startsOn: new Date(),
            expiresOn: new Date(new Date().valueOf() + 3600 * 1000)
        };

        const sasToken = generateBlobSASQueryParameters(sasOptions, config.azure.blobServiceClient.credential).toString();
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
        await containerClient.createIfNotExists({ access: 'blob' });

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
