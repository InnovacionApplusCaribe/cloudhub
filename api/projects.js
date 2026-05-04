// Vercel Serverless Function: GET /api/projects
// Local project management requires persistent filesystem not available on Vercel.
// Returns cloud projects only.
const { getAzureClients, listBlobProjects } = require('./_lib/azure');

module.exports = async (req, res) => {
    const az = getAzureClients();

    if (!az.isCloudEnabled) {
        return res.status(200).json([]);
    }

    try {
        const projects = await listBlobProjects();
        res.status(200).json(projects);
    } catch (err) {
        console.error('[Projects] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
};
