const { Configuration, OpenAIApi } = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_TIMEOUT_MS = 60_000;

const OPENAI_MODEL_SIMPLE = 'gpt-4o-mini';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';

let _client = null;

// openai SDK v3 (axios-based) — Node 14 compatible.
const getOpenAI = () => {
  if (_client) return _client;

  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured. Set it in your .env file.');
  }

  _client = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

  return _client;
};

const FENCE_RE = /```(?:json)?/g;

const callOpenAI = async (args) => {
  const model = args.model ?? OPENAI_MODEL_SIMPLE;

  const response = await getOpenAI().createChatCompletion(
    {
      model,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      temperature: args.temperature ?? 0.0,
      max_tokens: args.maxTokens ?? 150,
      ...(args.responseFormat ? { response_format: args.responseFormat } : {}),
    },
    { timeout: OPENAI_TIMEOUT_MS },
  );

  const raw = (response.data.choices[0]?.message?.content ?? '').trim();

  return raw
    .replace(FENCE_RE, '')
    .trim()
    .replace(/`+$/, '')
    .trim();
};

const parseJsonResponse = (raw, fallback) => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const embed = async (texts) => {
  const inputs = Array.isArray(texts) ? texts : [texts];

  const res = await getOpenAI().createEmbedding(
    {
      model: OPENAI_EMBED_MODEL,
      input: inputs,
    },
    { timeout: OPENAI_TIMEOUT_MS },
  );

  return res.data.data.map((d) => {
    const v = new Float32Array(d.embedding);

    let norm = 0;
    for (let i = 0; i < v.length; i++) {
      norm += v[i] * v[i];
    }

    norm = Math.sqrt(norm) || 1;

    for (let i = 0; i < v.length; i++) {
      v[i] /= norm;
    }

    return v;
  });
};

module.exports = {
  getOpenAI,
  callOpenAI,
  parseJsonResponse,
  embed,
};
