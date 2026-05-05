// Vercel Serverless Function: GET /api/proxy-blob
// Generic proxy for Azure Blob Storage requests to bypass browser CORS restrictions.
// Used by Potree point cloud loader (cloud.js, .hrc hierarchy, .bin data files).
module.exports = async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(200).end();
    }

    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter required' });
    }

    try {
        const response = await fetch(targetUrl);
        if (!response.ok) {
            return res.status(response.status).send(response.statusText);
        }

        // Forward relevant headers
        const contentType = response.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);

        const contentLength = response.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        // Allow cross-origin access from any origin (same-origin Vercel pages)
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Cache for 5 minutes to reduce repeated proxy calls for the same resource
        res.setHeader('Cache-Control', 'public, max-age=300');

        // Buffer the response and send it
        const buffer = Buffer.from(await response.arrayBuffer());
        res.status(200).send(buffer);
    } catch (err) {
        console.error('[Proxy-Blob] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
};
