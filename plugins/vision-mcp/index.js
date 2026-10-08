/**
 * Vision MCP plugin for camofox-browser.
 *
 * Analyzes browser screenshots using free vision models:
 *   Primary: OpenRouter free (Llama 3.2 Vision 90B)
 *   Fallback: Ollama local (llava-qwen / qwen2.5-vl)
 *
 * Endpoints:
 *   POST /vision/analyze   → { image: base64, prompt? } → analysis
 *   POST /vision/describe   → { image: base64 } → full page description
 *   POST /vision/ask        → { image: base64, question } → visual QA
 *   GET  /vision/status     → provider health, model info
 *
 * No auth — tailnet-only (like canvas & vault-login).
 */

import { analyzeImage as openRouterAnalyze, OpenRouterError, FREE_VISION_MODELS } from './openrouter-vision.js';
import { analyzeImage as ollamaAnalyze, isOllamaAvailable, findVisionModel, OllamaError } from './ollama-vision.js';

// ── No-op auth for tailnet-only endpoints ──
function noAuth(req, res, next) { next(); }

// ── Plugin registration ──
export async function register(app, ctx, pluginConfig = {}) {
  const { config, log, safeError } = ctx;

  const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
  const primaryModel = pluginConfig.visionModel || FREE_VISION_MODELS.primary;

  log('info', 'vision-mcp: enabled', {
    hasApiKey: !!openRouterApiKey,
    primaryModel,
  });

  // ── POST /vision/analyze ────────────────────────────

  app.post('/vision/analyze', noAuth, async (req, res) => {
    try {
      const { image, prompt } = req.body;
      if (!image) {
        return res.status(400).json({ error: 'image (base64) is required' });
      }
      if (typeof image !== 'string' || image.length < 100) {
        return res.status(400).json({ error: 'image must be a valid base64 string (min 100 chars)' });
      }

      log('info', 'vision analyze: starting', {
        imageLength: image.length,
        promptLength: (prompt || '').length,
      });

      // Strategy: try OpenRouter first, fall back to Ollama
      let result;
      let usedProvider = '';

      if (openRouterApiKey) {
        try {
          result = await openRouterAnalyze(image, prompt, {
            apiKey: openRouterApiKey,
            model: primaryModel,
            log,
          });
          usedProvider = 'openrouter';
        } catch (err) {
          if (err instanceof OpenRouterError && err.code === 'rate_limit') {
            log('warn', 'vision-mcp: OpenRouter rate limited, falling back to Ollama', { error: err.message });
          } else {
            log('warn', 'vision-mcp: OpenRouter failed, falling back to Ollama', { error: err.message });
          }
        }
      } else {
        log('info', 'vision-mcp: no OpenRouter API key, using Ollama directly');
      }

      // Fallback to Ollama if OpenRouter didn't produce a result
      if (!result) {
        try {
          result = await ollamaAnalyze(image, prompt, { log });
          usedProvider = 'ollama';
        } catch (err) {
          log('error', 'vision-mcp: both providers failed', { error: err.message });
          return res.status(502).json({
            error: 'All vision providers failed',
            details: err.message,
            providers: { openrouter: !!openRouterApiKey, ollama: true },
          });
        }
      }

      log('info', 'vision analyze: done', {
        provider: usedProvider,
        textLength: result.text.length,
      });

      res.json({
        ok: true,
        text: result.text,
        model: result.model,
        provider: result.provider,
        length: result.text.length,
      });
    } catch (err) {
      log('error', 'vision analyze failed', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // ── POST /vision/describe ───────────────────────────

  app.post('/vision/describe', noAuth, async (req, res) => {
    try {
      const { image } = req.body;
      if (!image) {
        return res.status(400).json({ error: 'image (base64) is required' });
      }

      // Forward as analyze with a descriptive prompt
      const prompt = 'Describe this browser page in detail. What elements do you see? What is the layout, '
        + 'what buttons, links, forms, text fields, images are present? Describe the visual state.';

      // Reuse the main analyze logic
      const analyzeReq = { body: { image, prompt } };
      const analyzeRes = { status: () => {}, json: () => {}, _json: null };

      // We'll inline the logic rather than proxying
      let result;
      if (openRouterApiKey) {
        try {
          result = await openRouterAnalyze(image, prompt, { apiKey: openRouterApiKey, model: primaryModel, log });
        } catch {
          // fall through
        }
      }

      if (!result) {
        result = await ollamaAnalyze(image, prompt, { log });
      }

      res.json({
        ok: true,
        text: result.text,
        model: result.model,
        provider: result.provider,
        length: result.text.length,
      });
    } catch (err) {
      log('error', 'vision describe failed', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // ── POST /vision/ask ────────────────────────────────

  app.post('/vision/ask', noAuth, async (req, res) => {
    try {
      const { image, question } = req.body;
      if (!image) return res.status(400).json({ error: 'image (base64) is required' });
      if (!question) return res.status(400).json({ error: 'question is required' });

      let result;
      if (openRouterApiKey) {
        try {
          result = await openRouterAnalyze(image, question, { apiKey: openRouterApiKey, model: primaryModel, log });
        } catch {
          // fall through
        }
      }

      if (!result) {
        result = await ollamaAnalyze(image, question, { log });
      }

      res.json({
        ok: true,
        answer: result.text,
        model: result.model,
        provider: result.provider,
        length: result.text.length,
      });
    } catch (err) {
      log('error', 'vision ask failed', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  // ── GET /vision/status ──────────────────────────────

  app.get('/vision/status', noAuth, async (req, res) => {
    try {
      const ollamaAvailable = await isOllamaAvailable(log);
      const activeVisionModel = ollamaAvailable ? await findVisionModel(log) : null;

      res.json({
        ok: true,
        version: '1.0.0',
        providers: {
          openrouter: {
            available: !!openRouterApiKey,
            model: primaryModel,
          },
          ollama: {
            available: ollamaAvailable,
            model: activeVisionModel,
          },
        },
        activeProvider: openRouterApiKey ? 'openrouter' : (ollamaAvailable ? 'ollama' : 'none'),
        tip: ollamaAvailable ? null : 'Install a vision model: ollama pull moondream',
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: safeError(err) });
    }
  });

  log('info', 'vision-mcp: registered 4 endpoints');
}
