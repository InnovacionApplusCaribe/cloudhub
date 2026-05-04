// Vercel Serverless Function: GET /api/proxy-layer
// Proxies requests to Azure Blob Storage to bypass browser CORS restrictions.
module.exports = async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });

    try {
        const response = await fetch(targetUrl);
        if (!response.ok) {
            return res.status(response.status).send(response.statusText);
        }

        const contentType = response.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);

        const contentLength = response.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        // Buffer the response and send it
        const buffer = Buffer.from(await response.arrayBuffer());
        res.status(200).send(buffer);
    } catch (err) {
        console.error('[Proxy] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
};
