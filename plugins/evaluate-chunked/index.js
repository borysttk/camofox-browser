/**
 * evaluate-chunked plugin for Camofox Browser.
 *
 * Registers POST /tabs/:tabId/evaluate-chunked — evaluates JavaScript in the page
 * and returns the result in fixed-size chunks to bypass Camofox's ~100-150 char
 * JSON serialization truncation on long strings.
 *
 * Usage:
 *   POST /tabs/:tabId/evaluate-chunked
 *   Body: { userId, expression, chunkSize?: number }
 *   Response: { ok: true, chunks: string[], totalLength: number, tabId: string }
 */

function findTab(session, tabId) {
  if (!session || !session.tabGroups) return null;
  for (const [, group] of session.tabGroups) {
    if (group.has(tabId)) {
      const tabState = group.get(tabId);
      return { tabState, group };
    }
  }
  return null;
}

function tabNotFoundResponse(res, tabId) {
  return res.status(404).json({ error: `Tab not found: ${tabId}` });
}

export async function register(app, ctx, pluginConfig = {}) {
  const { log, config, sessions, ensureBrowser, getSession,
          withUserLimit, createLeasedPage, closeLeasedPage, normalizeUserId,
          validateUrl, safeError, buildProxyUrl, proxyPool,
          failuresTotal } = ctx;

  const CHUNK_SIZE = pluginConfig.chunkSize || 20;
  const middleware = pluginConfig.auth === true ? ctx.auth() : (_req, _res, next) => next();

  /**
   * @openapi
   * /tabs/{tabId}/evaluate-chunked:
   *   post:
   *     tags: [Content]
   *     summary: Evaluate JS with chunked response to bypass JSON truncation
   *     description: |
   *       Evaluates a JavaScript expression in the page and returns the result
   *       in fixed-size chunks. This bypasses the Camofox server.js JSON
   *       serialization truncation that cuts long strings at ~100-150 chars.
   *       Reassemble chunks client-side using totalLength.
   *     parameters:
   *       - name: tabId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *         description: Tab identifier
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [userId, expression]
   *             properties:
   *               userId:
   *                 type: string
   *                 description: User identifier
   *               expression:
   *                 type: string
   *                 description: JavaScript expression to evaluate
   *               chunkSize:
   *                 type: integer
   *                 default: 20
   *                 description: Characters per chunk (configurable via plugin config)
   *     responses:
   *       200:
   *         description: Chunked result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *                 chunks:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: Result split into fixed-size chunks
   *                 totalLength:
   *                   type: integer
   *                   description: Total length of the original result string
   *                 tabId:
   *                   type: string
   *                 resultType:
   *                   type: string
   *       400:
   *         description: Missing userId or expression
   *       404:
   *         description: Tab not found
   *       500:
   *         description: Evaluate error
   */
  app.post('/tabs/:tabId/evaluate-chunked', middleware, async (req, res) => {
    const reqId = req.reqId;
    try {
      const { userId, expression, chunkSize = CHUNK_SIZE } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      if (!expression) return res.status(400).json({ error: 'expression is required' });

      const session = sessions.get(normalizeUserId(userId));
      const found = session && findTab(session, req.params.tabId);
      if (!found) return tabNotFoundResponse(res, req.params.tabId || req.body?.tabId);

      session.lastAccess = Date.now();
      const { tabState } = found;
      tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;

      const result = await withUserLimit(userId, () => tabState.page.evaluate(expression));

      // Chunk the result into fixed-size pieces
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      const chunks = [];
      for (let i = 0; i < resultStr.length; i += chunkSize) {
        chunks.push(resultStr.substring(i, i + chunkSize));
      }

      log('info', 'evaluate-chunked', { reqId, tabId: req.params.tabId, userId, totalLength: resultStr.length, chunkCount: chunks.length });
      res.json({ ok: true, chunks, totalLength: resultStr.length, tabId: req.params.tabId, resultType: typeof result });
    } catch (err) {
      log('error', 'evaluate-chunked failed', { reqId: req.reqId, tabId: req.params.tabId, error: err.message });
      res.status(500).json({ error: safeError ? safeError(err) : err.message });
    }
  });
}
