/**
 * Shared Azure Blob Storage utilities for Vercel Serverless Functions.
 * Self-contained — does NOT depend on server/config or server/services.
 */

const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');

let _cached = null;

function getAzureClients() {
    if (_cached) return _cached;

    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) {
        _cached = { isCloudEnabled: false };
        return _cached;
    }

    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
        const accountNameMatch = connStr.match(/AccountName=([^;]+)/);
        const accountKeyMatch = connStr.match(/AccountKey=([^;]+)/);

        _cached = {
            isCloudEnabled: true,
            blobServiceClient,
            accountName: accountNameMatch ? accountNameMatch[1] : '',
            accountKey: accountKeyMatch ? accountKeyMatch[1] : '',
            rawContainer: process.env.AZURE_RAW_CONTAINER_NAME || 'raw-las',
            convertedContainer: process.env.AZURE_CONVERTED_CONTAINER_NAME || 'converted-potree',
        };
    } catch (err) {
        console.error('[Azure Init] Failed:', err.message);
        _cached = { isCloudEnabled: false };
    }

    return _cached;
}

/** Generate a read-only SAS token for the converted container (24h). */
async function getReadSasToken() {
    const az = getAzureClients();
    if (!az.isCloudEnabled || !az.accountKey) return '';

    const cred = new StorageSharedKeyCredential(az.accountName, az.accountKey);
    const token = generateBlobSASQueryParameters({
        containerName: az.convertedContainer,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: new Date(),
        expiresOn: new Date(Date.now() + 24 * 3600 * 1000),
    }, cred).toString();

    return token;
}

/** List top-level project prefixes in the converted container. */
async function listBlobProjects() {
    const az = getAzureClients();
    if (!az.isCloudEnabled) return [];

    const containerClient = az.blobServiceClient.getContainerClient(az.convertedContainer);
    const baseUrl = `https://${az.accountName}.blob.core.windows.net/${az.convertedContainer}`;
    const projects = [];

    try {
        for await (const item of containerClient.listBlobsByHierarchy('/')) {
            if (item.kind === 'prefix') {
                const name = item.name.replace(/\/$/, '');
                projects.push({
                    name,
                    url: `${baseUrl}/${name}/metadata.json`,
                    type: 'pointcloud',
                    storageMode: 'cloud',
                    source: 'blob',
                });
            }
        }
    } catch (err) {
        console.error('[Azure] listBlobProjects error:', err.message);
    }

    return projects;
}

/** Probe Azure to find the correct manifest path for a project. */
async function resolveCloudManifestUrl(projectName) {
    const az = getAzureClients();
    const baseUrl = `https://${az.accountName}.blob.core.windows.net/${az.convertedContainer}`;

    if (!az.isCloudEnabled) return `${baseUrl}/${projectName}/metadata.json`;

    const containerClient = az.blobServiceClient.getContainerClient(az.convertedContainer);
    const candidates = [
        `${projectName}/metadata.json`,
        `${projectName}/pointclouds/index/metadata.json`,
        `${projectName}/pointclouds/index/cloud.js`,
        `${projectName}/cloud.js`,
    ];

    for (const candidate of candidates) {
        try {
            const exists = await containerClient.getBlobClient(candidate).exists();
            if (exists) return `${baseUrl}/${candidate}`;
        } catch (_) { /* skip */ }
    }

    return `${baseUrl}/${projectName}/metadata.json`;
}

/** Fetch layers.json from a project folder in Azure. */
async function getProjectLayers(projectId) {
    const az = getAzureClients();
    if (!az.isCloudEnabled) return [];

    const containerClient = az.blobServiceClient.getContainerClient(az.convertedContainer);
    const blobClient = containerClient.getBlobClient(`${projectId}/layers.json`);

    try {
        const exists = await blobClient.exists();
        if (!exists) return [];

        const dl = await blobClient.download();
        const chunks = [];
        for await (const chunk of dl.readableStreamBody) {
            chunks.push(chunk.toString());
        }
        return JSON.parse(chunks.join(''));
    } catch (err) {
        console.error(`[Azure] getProjectLayers error for ${projectId}:`, err.message);
        return [];
    }
}

module.exports = {
    getAzureClients,
    getReadSasToken,
    listBlobProjects,
    resolveCloudManifestUrl,
    getProjectLayers,
};
