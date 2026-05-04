// Vercel Serverless Function: GET /api/project-layers/[id]
const { getAzureClients, getProjectLayers, getReadSasToken } = require('../_lib/azure');

module.exports = async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Project ID required' });

    const az = getAzureClients();

    try {
        let layers = [];

        if (az.isCloudEnabled) {
            layers = await getProjectLayers(id);

            // Append SAS tokens so the viewer can load cloud-hosted layers
            if (layers.length > 0) {
                try {
                    const sasToken = await getReadSasToken();
                    if (sasToken) {
                        layers = layers.map(l => {
                            if (l.url && l.url.includes('.blob.core.windows.net')) {
                                return { ...l, url: `${l.url.split('?')[0]}?${sasToken}` };
                            }
                            return l;
                        });
                    }
                } catch (e) {
                    console.error('[ProjectLayers] SAS generation failed:', e.message);
                }
            }
        }

        res.status(200).json(layers);
    } catch (err) {
        console.error('[ProjectLayers] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
};
