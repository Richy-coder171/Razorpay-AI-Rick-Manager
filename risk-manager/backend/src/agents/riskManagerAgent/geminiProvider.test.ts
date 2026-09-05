/**
 * GeminiProvider unit tests — verify the request the provider sends
 * (auth header, model, messages, timeout) against the documented
 * OpenAI-compatible chat/completions contract, WITHOUT any real key.
 * Network is stubbed; the key comes from config only.
 */

import { GeminiProvider } from './provider';
import { config } from '../../config';

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function stubFetch(opts: { status?: number; body?: unknown; ok?: boolean } = {}) {
  const fetchMock = jest.fn().mockResolvedValue(
    new Response(JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('GeminiProvider', () => {
  it('sends the documented request shape: Bearer auth, model, system+user messages', async () => {
    const fetchMock = stubFetch({
      body: { choices: [{ message: { content: '{"module":"fraud_spike"}' } }] },
    });
    const provider = new GeminiProvider();

    const text = await provider.complete('SYSTEM_PROMPT', 'USER_PROMPT');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    // Authorization is exactly "Bearer <configured key>" — no baked-in secret.
    expect(headers.Authorization).toBe(`Bearer ${config.gemini_api_key}`);
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(config.gemini_model);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYSTEM_PROMPT' },
      { role: 'user', content: 'USER_PROMPT' },
    ]);
    expect(text).toBe('{"module":"fraud_spike"}');
  });

  it('NEVER hardcodes an API key — sends exactly the configured one, whatever it is', async () => {
    const fetchMock = stubFetch({ body: { choices: [{ message: { content: 'x' } }] } });
    const provider = new GeminiProvider();
    await provider.complete('s', 'u');

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    // The Authorization header must be EXACTLY "Bearer <configured key>" — the
    // value comes from config (env), never from source. Assert the shape and
    // the equality with the configured value WITHOUT printing the key itself
    // (a real key in .env must never leak into test output).
    expect(headers.Authorization.startsWith('Bearer ')).toBe(true);
    expect(headers.Authorization).toBe(`Bearer ${config.gemini_api_key}`);
    // The request body never carries the key.
    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string;
    if (config.gemini_api_key) {
      expect(body).not.toContain(config.gemini_api_key);
    }
  });

  it('throws on non-2xx so the agent falls back to the mock', async () => {
    stubFetch({ status: 401, body: { error: { message: 'API key not valid' } } });
    const provider = new GeminiProvider();
    await expect(provider.complete('s', 'u')).rejects.toThrow(/401/);
  });

  it('throws on an empty completion so no fabricated output is possible', async () => {
    stubFetch({ body: { choices: [{ message: { content: '' } }] } });
    const provider = new GeminiProvider();
    await expect(provider.complete('s', 'u')).rejects.toThrow(/empty completion/);
  });
});
