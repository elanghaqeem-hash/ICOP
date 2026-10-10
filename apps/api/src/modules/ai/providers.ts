/**
 * Adapter penyedia LLM. Semua menerima format pesan yang sama dan mengembalikan
 * { text, inputTokens, outputTokens }. Model ID dapat diubah di DB / env tanpa ubah kode —
 * verifikasi nama model ke dokumentasi masing-masing provider sebelum produksi.
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'mistral' | 'groq' | 'openrouter' | 'custom';

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  timeoutMs: number;
}
export interface ChatRequest { system: string; user: string; maxTokens: number; temperature: number }
export interface ChatResult { text: string; inputTokens?: number; outputTokens?: number }
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const PROVIDER_DEFAULTS: Record<ProviderName, { model: string; baseUrl: string; keyEnv: string; label: string }> = {
  anthropic: { label: 'Anthropic Claude', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  gemini: { label: 'Google Gemini', model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyEnv: 'GEMINI_API_KEY' },
  mistral: { label: 'Mistral AI', model: 'mistral-small-latest', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY' },
  groq: { label: 'Groq', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  openrouter: { label: 'OpenRouter', model: 'openrouter/auto', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  custom: { label: 'OpenAI-compatible (Ollama/vLLM/cloud lain)', model: 'llama3.1', baseUrl: '', keyEnv: 'CUSTOM_LLM_API_KEY' },
};

export class ProviderError extends Error {
  constructor(public provider: string, public status: number | null, message: string, public retryable = true) {
    super(message);
  }
}

async function postJson(fetchImpl: FetchLike, provider: string, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      // Jangan bocorkan isi respons penuh (bisa memuat echo prompt); cukup potongan pendek
      throw new ProviderError(provider, res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 404);
    }
    try { return JSON.parse(text); } catch { throw new ProviderError(provider, res.status, 'Respons bukan JSON'); }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if ((e as Error).name === 'AbortError') throw new ProviderError(provider, null, `Timeout ${timeoutMs}ms`);
    throw new ProviderError(provider, null, `Network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function openAiCompatible(name: ProviderName) {
  return async (cfg: ProviderConfig, req: ChatRequest, f: FetchLike): Promise<ChatResult> => {
    const base = (cfg.baseUrl || PROVIDER_DEFAULTS[name].baseUrl).replace(/\/$/, '');
    if (!base) throw new ProviderError(name, null, 'base_url belum dikonfigurasi', false);
    const headers: Record<string, string> = { authorization: `Bearer ${cfg.apiKey}` };
    if (name === 'openrouter') { headers['x-title'] = 'ICOP CyberBusiness 360'; }
    const j = await postJson(f, name, `${base}/chat/completions`, headers, {
      model: cfg.model, max_tokens: req.maxTokens, temperature: req.temperature,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
    }, cfg.timeoutMs);
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError(name, 200, 'Respons kosong');
    return { text, inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens };
  };
}

export const ADAPTERS: Record<ProviderName, (cfg: ProviderConfig, req: ChatRequest, f: FetchLike) => Promise<ChatResult>> = {
  anthropic: async (cfg, req, f) => {
    const base = (cfg.baseUrl || PROVIDER_DEFAULTS.anthropic.baseUrl).replace(/\/$/, '');
    const j = await postJson(f, 'anthropic', `${base}/v1/messages`, { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: cfg.model, max_tokens: req.maxTokens, temperature: req.temperature, system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }, cfg.timeoutMs);
    const text = (j?.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    if (!text.trim()) throw new ProviderError('anthropic', 200, 'Respons kosong');
    return { text, inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens };
  },
  gemini: async (cfg, req, f) => {
    const base = (cfg.baseUrl || PROVIDER_DEFAULTS.gemini.baseUrl).replace(/\/$/, '');
    const j = await postJson(f, 'gemini', `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`, { 'x-goog-api-key': cfg.apiKey }, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature },
    }, cfg.timeoutMs);
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
    if (!text.trim()) throw new ProviderError('gemini', 200, `Respons kosong (${j?.candidates?.[0]?.finishReason ?? 'no candidate'})`);
    return { text, inputTokens: j.usageMetadata?.promptTokenCount, outputTokens: j.usageMetadata?.candidatesTokenCount };
  },
  openai: openAiCompatible('openai'),
  mistral: openAiCompatible('mistral'),
  groq: openAiCompatible('groq'),
  openrouter: openAiCompatible('openrouter'),
  custom: openAiCompatible('custom'),
};
