// Vercel Serverless Function: GET /api/config
const { getAzureClients } = require('./_lib/azure');

module.exports = (req, res) => {
    const az = getAzureClients();
    res.status(200).json({
        isCloudEnabled: az.isCloudEnabled,
        azureContainer: az.rawContainer || 'raw-las',
        platform: 'vercel',
    });
};
