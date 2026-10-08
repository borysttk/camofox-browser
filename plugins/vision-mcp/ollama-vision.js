/**
 * Ollama Vision — local vision model client.
 *
 * Uses locally-hosted vision models (moondream, llava, qwen2.5-vl).
 * Acts as fallback when OpenRouter free tier is rate-limited.
 *
 * To add a vision model locally:
 *   ollama pull moondream      # ~1.6GB — fast, good for basic vision
 *   ollama pull llava:7b       # ~4.0GB — more capable
 *   ollama pull qwen2.5-vl:7b  # ~4.5GB — best OCR
 */

const OLLAMA_URL = 'http://localhost:11434';

// Vision-capable models, ordered by preference (first found is used).
// Text-only variants like llava-qwen-0.5b:text are excluded.
const LOCAL_VISION_MODELS = [
  'moondream:latest',
  'llava:7b',
  'llava:13b',
  'llava-llama3:latest',
  'qwen2.5-vl:7b',
  'qwen2.5-vl:72b',
  'minicpm-v:latest',
];

/**
 * Find the first vision-capable model available in Ollama.
 * Returns model name or null.
 */
export async function findVisionModel(log = () => {}) {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const installedModels = (data?.models || []).map(m => m.name);

    log('debug', 'ollama vision: scanning installed models', { installedModels });

    for (const candidate of LOCAL_VISION_MODELS) {
      if (installedModels.some(installed =>
        installed === candidate || installed.startsWith(candidate.split(':')[0])
      )) {
        const matched = installedModels.find(m =>
          m === candidate || m.startsWith(candidate.split(':')[0])
        );
        log('info', 'ollama vision: found vision model', { candidate, matched });
        return matched;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Analyze an image using a local Ollama vision model.
 *
 * @param {string} base64Image - Base64-encoded PNG/JPEG image
 * @param {string} prompt - What to ask about the image
 * @param {object} options - { model?, signal?, log? }
 * @returns {Promise<{text: string, model: string, provider: string}>}
 */
export async function analyzeImage(base64Image, prompt, options = {}) {
  const { signal, log = () => {} } = options;

  let model = options.model;
  if (!model) {
    model = await findVisionModel(log);
  }

  if (!model) {
    throw new OllamaError('No Ollama vision model available. Pull one: ollama pull moondream', 'no_models');
  }

  const body = {
    model,
    prompt: prompt || 'Describe this image in detail.',
    images: [base64Image],
    stream: false,
    options: {
      num_predict: 512,
      temperature: 0.2,
    },
  };

  log('debug', 'ollama vision: sending request', {
    model,
    imageLength: base64Image.length,
    promptLength: (prompt || '').length,
  });

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let errorBody;
    try {
      const raw = await response.text();
      const parsed = JSON.parse(raw);
      errorBody = parsed?.error || raw;
    } catch {
      errorBody = response.statusText;
    }
    throw new OllamaError(
      `Ollama error: ${response.status} — ${String(errorBody).substring(0, 200)}`,
      'api_error',
      response.status
    );
  }

  const data = await response.json();
  const text = data?.response || '';

  log('info', 'ollama vision: response received', {
    model: data.model || model,
    responseLength: text.length,
    tokensEvaluated: data.eval_count,
  });

  return {
    text,
    model: data.model || model,
    provider: 'ollama',
  };
}

/**
 * Check if Ollama is running and has at least one vision-capable model.
 */
export async function isOllamaAvailable(log = () => {}) {
  const model = await findVisionModel(log);
  return model !== null;
}

export class OllamaError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export { LOCAL_VISION_MODELS };
