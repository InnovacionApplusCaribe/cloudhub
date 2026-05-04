// Vercel Serverless Function: GET /api/list
const { getAzureClients, listBlobProjects, resolveCloudManifestUrl, getReadSasToken } = require('./_lib/azure');

module.exports = async (req, res) => {
    try {
        const az = getAzureClients();
        let cloud = [];

        if (az.isCloudEnabled) {
            try {
                const blobProjects = await listBlobProjects();

                // Generate SAS token for read access
                let sasToken = '';
                try {
                    sasToken = await getReadSasToken();
                } catch (e) {
                    console.error('[API List] SAS generation failed:', e.message);
                }

                // Resolve manifest URLs and attach SAS tokens
                cloud = await Promise.all(
                    blobProjects.map(async (p) => {
                        let url = p.url || '';

                        // Try to resolve the actual manifest URL
                        try {
                            const resolvedUrl = await resolveCloudManifestUrl(p.name);
                            url = resolvedUrl;
                        } catch (e) {
                            console.warn(`[API List] Could not resolve manifest for ${p.name}:`, e.message);
                        }

                        const baseUrl = url.split('?')[0];

                        return {
                            ...p,
                            url: sasToken ? `${baseUrl}?${sasToken}` : baseUrl,
                            storageMode: 'cloud',
                        };
                    })
                );
            } catch (cloudErr) {
                console.error('[API List] Cloud enumeration failed:', cloudErr.message);
            }
        }

        res.status(200).json({
            uploads: cloud,
            examples: [],
            cloudProjectsCount: cloud.length,
            localProjectsCount: 0,
            cached: false,
            timestamp: Date.now(),
        });
    } catch (err) {
        console.error('[API List] Error:', err);
        res.status(500).json({ error: 'Failed to list projects' });
    }
};
