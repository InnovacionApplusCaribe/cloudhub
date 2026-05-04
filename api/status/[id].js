// Vercel Serverless Function: GET /api/status/[id]
// Job status tracking requires in-memory state not available across serverless invocations.
module.exports = (req, res) => {
    const { id } = req.query;
    res.status(404).json({
        error: 'Job not found',
        detail: 'Job status tracking is not available on Vercel (no shared in-memory state between serverless invocations).',
        jobId: id,
    });
};
