// Vercel Serverless Function: DELETE /api/delete/[id]
const { getAzureClients } = require('../_lib/azure');

module.exports = async (req, res) => {
    if (req.method !== 'DELETE') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Project ID required' });

    const az = getAzureClients();
    if (!az.isCloudEnabled) {
        return res.status(503).json({ error: 'Cloud storage not enabled. Local deletion not available on Vercel.' });
    }

    try {
        const containerClient = az.blobServiceClient.getContainerClient(az.convertedContainer);

        // Delete all blobs with the project prefix
        let deletedCount = 0;
        for await (const blob of containerClient.listBlobsFlat({ prefix: id })) {
            await containerClient.deleteBlob(blob.name);
            deletedCount++;
        }

        if (deletedCount === 0) {
            return res.status(404).json({ error: 'Project not found in cloud storage' });
        }

        console.log(`[Delete] Deleted ${deletedCount} blobs for project: ${id}`);
        res.status(200).json({ success: true, mode: 'cloud', deletedBlobs: deletedCount });
    } catch (err) {
        console.error(`[Delete] Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
};
