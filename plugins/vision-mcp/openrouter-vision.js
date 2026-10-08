/**
 * OpenRouter Vision — free-tier vision API client.
 *
 * Uses Llama 3.2 Vision 90B (free) as primary, falls back to
 * smaller free models on rate limit.
 */

const FREE_VISION_MODELS = {
  primary: 'meta-llama/llama-3.2-90b-vision-instruct',
  fallback: 'meta-llama/llama-3.2-11b-vision-instruct',
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Analyze an image using OpenRouter free vision models.
 *
 * @param {string} base64Image - Base64-encoded PNG/JPEG image
 * @param {string} prompt - What to ask about the image
 * @param {object} options - { apiKey, model?, signal?, log? }
 * @returns {Promise<{text: string, model: string, provider: string}>}
 */
export async function analyzeImage(base64Image, prompt, options = {}) {
  const {
    apiKey = '',
    model = FREE_VISION_MODELS.primary,
    signal,
    log = () => {},
  } = options;

  if (!apiKey) {
    throw new OpenRouterError('OPENROUTER_API_KEY not configured', 'config');
  }

  const dataUrl = base64Image.startsWith('data:')
    ? base64Image
    : `data:image/png;base64,${base64Image}`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt || 'Describe this image in detail.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
        ],
      },
    ],
    max_tokens: 1024,
  };

  log('debug', 'openrouter vision: sending request', {
    model,
    imageLength: base64Image.length,
    promptLength: (prompt || '').length,
  });

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/jo-inc/camofox-browser',
      'X-Title': 'Camofox Vision MCP',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new OpenRouterError('OpenRouter rate limited', 'rate_limit', response.status);
    }
    throw new OpenRouterError(
      `OpenRouter API error: ${response.status} ${errorBody.substring(0, 200)}`,
      'api_error',
      response.status
    );
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';

  log('info', 'openrouter vision: response received', {
    model: data.model || model,
    usage: data.usage,
    responseLength: text.length,
  });

  return {
    text,
    model: data.model || model,
    provider: 'openrouter',
  };
}

export class OpenRouterError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'OpenRouterError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export { FREE_VISION_MODELS };
