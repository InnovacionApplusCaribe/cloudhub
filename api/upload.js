// Vercel Serverless Function: POST /api/upload
// Local uploads are not supported on Vercel (no persistent filesystem).
module.exports = (req, res) => {
    res.status(503).json({
        error: 'Local file upload is not available on the Vercel deployment. Please use Azure Cloud upload mode, or deploy to a platform with persistent storage (Azure App Service, Railway, Render).',
    });
};
