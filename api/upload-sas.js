/**
 * @api {GET} /api/upload-sas Generate Azure Blob Storage Upload SAS URL
 * @apiDescription Serverless function (Vercel) to generate a Shared Access Signature (SAS) URL,
 * allowing clients to upload a raw point cloud file directly and securely to Azure Blob Storage
 * without exposing storage credentials.
 * 
 * @apiQuery {String} fileName The name of the file to be uploaded. Used to generate a unique destination blob name.
 * 
 * @apiSuccess (200) {String} uploadUrl The signed Azure Blob Storage URL containing the temporary SAS token.
 * @apiSuccess (200) {String} blobName The unique generated blob file name in storage (formatted as UUID-fileName).
 * 
 * @apiError (400) {String} error "fileName parameter required" if the fileName query parameter is missing.
 * @apiError (503) {String} error "Cloud storage not enabled" if Azure configuration is missing or disabled.
 * @apiError (500) {String} error Server error message when SAS generation fails.
 * 
 * @apiPermission Authenticated/Authorized users (relies on Azure credentials configured in environment).
 */
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
