/**
 * API/CONFIG.JS
 * 
 * Endpoint: GET /api/config
 * 
 * PURPOSE:
 * Returns platform configuration visible to the frontend.
 * Used by the dashboard to determine which features are available.
 * 
 * RESPONSE:
 * {
 *   isCloudEnabled: true|false,        // Is Azure Blob Storage configured?
 *   azureContainer: "raw-las",         // Container name for uploads
 *   platform: "vercel|local|azure"     // Deployment platform
 * }
 * 
 * USAGE:
 * The frontend calls this on load to:
 * - Show/hide cloud upload option
 * - Display appropriate storage backend information
 * - Validate deployment configuration
 * 
 * CONFIGURATION SOURCE:
 * Reads from environment variables:
 * - AZURE_STORAGE_ACCOUNT: Azure account name
 * - AZURE_STORAGE_KEY: Azure account key
 * - AZURE_STORAGE_CONTAINER: Blob container (default: raw-las)
 * 
 * SECURITY:
 * - Only returns non-sensitive config
 * - Secrets (keys, tokens) never exposed
 * - Safe to call from any origin (CORS enabled)
 */

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
