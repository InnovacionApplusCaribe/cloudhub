// Vercel Serverless Function: POST /api/trigger-conversion-cloud
// Cloud conversion requires long-running processes not supported on Vercel.
module.exports = (req, res) => {
    res.status(503).json({
        error: 'Point cloud conversion is not available on Vercel (requires persistent filesystem and long-running processes). Please deploy to Azure App Service, Railway, or Render for full conversion support.',
    });
};
