// Vercel Serverless Function: GET /api/upload-sas
const { getAzureClients } = require('./_lib/azure');
const { v4: uuidv4 } = require('uuid');
const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');

module.exports = async (req, res) => {
    const fileName = req.query.fileName;

    if (!fileName) {
        return res.status(400).json({ error: 'fileName parameter required' });
    }

    const az = getAzureClients();
    if (!az.isCloudEnabled) {
        return res.status(503).json({ error: 'Cloud storage not enabled' });
    }

    try {
        const blobName = `${uuidv4()}-${fileName}`;
        const containerClient = az.blobServiceClient.getContainerClient(az.rawContainer);

        try { await containerClient.createIfNotExists(); } catch (_) { /* ok */ }

        const blobClient = containerClient.getBlobClient(blobName);
        const cred = new StorageSharedKeyCredential(az.accountName, az.accountKey);

        const sasToken = generateBlobSASQueryParameters({
            containerName: az.rawContainer,
            blobName: blobName,
            permissions: BlobSASPermissions.parse('racwd'),
            startsOn: new Date(),
            expiresOn: new Date(Date.now() + 3600 * 1000),
        }, cred).toString();

        res.status(200).json({
            uploadUrl: `${blobClient.url}?${sasToken}`,
            blobName,
        });
    } catch (err) {
        console.error('[Upload SAS] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
};
