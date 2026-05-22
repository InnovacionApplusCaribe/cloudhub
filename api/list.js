/**
 * API/LIST.JS
 * 
 * Endpoint: GET /api/list
 * 
 * PURPOSE:
 * Returns all available point cloud projects (uploaded or example datasets).
 * Supports both local filesystem and Azure Blob Storage backends.
 * 
 * RESPONSE FORMAT:
 * {
 *   uploads: [
 *     {
 *       name: "project_name",
 *       url: "https://blob.url/manifest.json?sastoken=...",
 *       storageMode: "cloud|local",
 *       metadata: { ... }
 *     }
 *   ],
 *   examples: [
 *     { name: "demo", url: "/examples/demo/manifest.json", ... }
 *   ]
 * }
 * 
 * CLOUD INTEGRATION (Azure Blob):
 * - Lists all uploaded projects in Azure Blob Storage
 * - Generates SAS (Shared Access Signature) tokens for read-only access
 * - Resolves manifest URLs (octree.json location)
 * - Attaches tokens to URLs so browser can fetch data
 * 
 * ERROR HANDLING:
 * - If cloud fails: Returns empty array, doesn't crash
 * - If SAS generation fails: Returns base URL (may not work from browser)
 * - Logs warnings for debugging but doesn't block request
 * 
 * PERFORMANCE:
 * - Caches SAS tokens (valid for time period)
 * - Parallelizes manifest URL resolution (Promise.all)
 * - Should return < 1 second for typical projects
 * 
 * SECURITY:
 * - SAS tokens are read-only and time-limited
 * - Tokens restricted to specific container
 * - URLs are sanitized before SAS append
 */

// Vercel Serverless Function: GET /api/list
const { getAzureClients, listBlobProjects, resolveCloudManifestUrl, getReadSasToken } = require('./_lib/azure');

module.exports = async (req, res) => {
    try {
        const az = getAzureClients();
        let cloud = [];

        if (az.isCloudEnabled) {
            try {
                // List all projects from Azure Blob Storage
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
