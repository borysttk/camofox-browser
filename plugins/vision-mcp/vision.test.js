/**
 * Vision MCP plugin — test suite.
 *
 * Tests: routing, error handling, fallback chain, status endpoint.
 * Uses mocked HTTP where possible; no real API calls.
 */

import { jest } from '@jest/globals';

// ── Mock fetch for OpenRouter/Ollama calls ──
let mockFetch;

beforeEach(() => {
  mockFetch = jest.fn();
  global.fetch = mockFetch;
});

afterEach(() => {
  delete global.fetch;
});

describe('openrouter-vision.js', () => {
  let mod;

  beforeAll(async () => {
    mod = await import('./openrouter-vision.js');
  });

  test('exports analyzeImage and error class', () => {
    expect(typeof mod.analyzeImage).toBe('function');
    expect(typeof mod.OpenRouterError).toBe('function');
    expect(typeof mod.FREE_VISION_MODELS.primary).toBe('string');
  });

  test('throws config error when no API key', async () => {
    await expect(mod.analyzeImage('base64data', 'test prompt'))
      .rejects.toThrow('OPENROUTER_API_KEY not configured');
  });

  test('returns text on successful response', async () => {
    const fakeImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'This is a test image showing a button.' } }],
        model: 'meta-llama/llama-3.2-90b-vision-instruct',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    });

    const result = await mod.analyzeImage(fakeImage, 'Describe this image', {
      apiKey: 'test-key',
      log: () => {},
    });

    expect(result.text).toBe('This is a test image showing a button.');
    expect(result.provider).toBe('openrouter');
    expect(result.model).toContain('llama');
  });

  test('throws OpenRouterError on rate limit (429)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    await expect(mod.analyzeImage('base64', 'prompt', { apiKey: 'key', log: () => {} }))
      .rejects.toThrow(mod.OpenRouterError);
  });

  test('throws OpenRouterError on 5xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    });

    await expect(mod.analyzeImage('base64', 'prompt', { apiKey: 'key', log: () => {} }))
      .rejects.toThrow('OpenRouter API error');
  });
});

describe('ollama-vision.js', () => {
  let mod;

  beforeAll(async () => {
    mod = await import('./ollama-vision.js');
  });

  test('exports analyzeImage and error class', () => {
    expect(typeof mod.analyzeImage).toBe('function');
    expect(typeof mod.isOllamaAvailable).toBe('function');
    expect(typeof mod.findVisionModel).toBe('function');
    expect(typeof mod.OllamaError).toBe('function');
  });

  test('isOllamaAvailable returns false when server unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await mod.isOllamaAvailable(() => {});
    expect(result).toBe(false);
  });

  test('isOllamaAvailable returns false when no vision models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'gemma-4:text' }, { name: 'mistral:text' }] }),
    });
    const result = await mod.isOllamaAvailable(() => {});
    expect(result).toBe(false);
  });

  test('isOllamaAvailable returns true when vision model present', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'moondream:latest' }, { name: 'gemma-4:text' }] }),
    });
    const result = await mod.isOllamaAvailable(() => {});
    expect(result).toBe(true);
  });

  test('findVisionModel finds moondream', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'moondream:latest' }, { name: 'gemma-4-E2B-it-q4_0:latest' }] }),
    });
    const result = await mod.findVisionModel(() => {});
    expect(result).toBe('moondream:latest');
  });

  test('findVisionModel returns null when no vision model', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'gemma-4-E2B-it-q4_0:latest' }] }),
    });
    const result = await mod.findVisionModel(() => {});
    expect(result).toBeNull();
  });

  test('analyzeImage returns text on success', async () => {
    const fakeImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    // findVisionModel call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'moondream:latest' }] }),
    });
    // generate call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: 'A simple test image with a blue background.',
        model: 'moondream:latest',
        eval_count: 10,
      }),
    });

    const result = await mod.analyzeImage(fakeImage, 'Describe', { log: () => {} });
    expect(result.text).toBe('A simple test image with a blue background.');
    expect(result.provider).toBe('ollama');
  });

  test('throws OllamaError when no vision model available', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'gemma-4:text' }] }),
    });

    await expect(mod.analyzeImage('base64', 'prompt', { log: () => {} }))
      .rejects.toThrow('No Ollama vision model available');
  });
});

describe('vision-mcp index.js (routing)', () => {
  let mod;

  beforeAll(async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    mod = await import('./index.js');
  });

  afterAll(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test('register is a function', () => {
    expect(typeof mod.register).toBe('function');
  });

  test('register creates all 4 endpoints', async () => {
    const routes = [];
    const mockApp = {
      get: (path, ...handlers) => routes.push({ method: 'GET', path }),
      post: (path, ...handlers) => routes.push({ method: 'POST', path }),
    };
    const mockCtx = {
      config: {},
      safeError: (e) => e.message,
      log: () => {},
    };

    await mod.register(mockApp, mockCtx, {});

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'POST', path: '/vision/analyze' }),
        expect.objectContaining({ method: 'POST', path: '/vision/describe' }),
        expect.objectContaining({ method: 'POST', path: '/vision/ask' }),
        expect.objectContaining({ method: 'GET', path: '/vision/status' }),
      ])
    );
  });
});
