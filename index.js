require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Configuration ----------
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';

const TEXT_MODEL_FALLBACKS = [
  'nvidia/nemotron-3.5-lightning:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'thinkingmachines/inkling:free',
  'liquid/lfm-2.5-2.6b:free',
  'poolside/laguna-s-2.1:free',
];

// The configured model is tried first, then the fallbacks. This chain matters
// more than it looks: free models get rate limited and sometimes return an
// empty stream, and with only one model any hiccup was a hard failure for the
// student. Falling through turns a dead end into a slightly slower answer.
const TEXT_MODELS = [...new Set([OPENROUTER_MODEL, ...TEXT_MODEL_FALLBACKS])];

// Vision-capable free models, tried in order until one answers.
//
// Every entry must genuinely accept image input. A text-only model in this
// list is a wasted round trip that always fails, so it was rebuilt from the
// models that report "image" among their input modalities.
const VISION_MODELS = [
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3.5-content-safety:free',
];

const REQUEST_TIMEOUT_MS = 30000;
const IMAGE_TIMEOUT_MS = 45000;
// Ceiling for the whole fallback chain, so trying several models cannot add up
// to minutes of silence before the student sees anything.
const TOTAL_ATTEMPT_BUDGET_MS = 50000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB base64 payload
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];

// ---------- Simple in-memory rate limiter ----------
// Protects the free AI budget from runaway clients. Per-IP, sliding window.
const RATE_LIMIT = { windowMs: 60_000, max: 30 };
const buckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = buckets.get(ip);

  if (!entry || now - entry.start > RATE_LIMIT.windowMs) {
    buckets.set(ip, { start: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT.max) {
    return res.status(429).json({ error: 'StudyBuddy is busy right now. Please try again.' });
  }
  return next();
}

// Periodically clean up old buckets so memory stays bounded.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT.windowMs;
  for (const [ip, entry] of buckets) {
    if (entry.start < cutoff) buckets.delete(ip);
  }
}, RATE_LIMIT.windowMs).unref();

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/api', rateLimit);

// ---------- Health ----------
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'StudyBuddy AI' });
});

// Identifies the running commit so a deploy can be confirmed rather than assumed.
const BUILD_ID = process.env.RENDER_GIT_COMMIT || 'local';

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    configured: !!OPENROUTER_API_KEY,
    model: OPENROUTER_MODEL,
    build: BUILD_ID,
    textModels: TEXT_MODELS.length,
    visionModels: VISION_MODELS.length,
  });
});

// ---------- Prompt building ----------
const SUBJECT_GUIDE = {
  Math: 'Show equations and every step. Explain why each step is taken and end with the final answer.',
  Science: 'Explain the underlying idea accurately, then connect it to everyday examples.',
  Chemistry: 'Be precise with formulas and units. Show calculations and, when relevant, balance equations step by step.',
  English: 'Explain grammar, comprehension and literary ideas clearly. Point to the evidence in the text.',
  History: 'Explain causes, key people, dates and consequences. Keep facts distinct from opinion.',
  Geography: 'Explain locations, physical processes and human patterns. Refer to maps where helpful.',
  'Computer Science': 'Explain code and concepts step by step. Show corrected examples when useful.',
  Languages: 'Explain vocabulary and grammar. Show how the sentence structure works.',
  Engineering: 'Show formulas with units, describe the design reasoning, and state assumptions.',
  Art: 'Explain technique, style and historical context. Describe what makes the work effective.',
  Music: 'Explain theory and notation using clear terms. Relate to pieces the student may know.',
  Economics: 'Explain the concept first, then apply it with a concrete example.',
  Psychology: 'Explain the theory accurately and illustrate it with a relatable example.',
  Other: 'Answer clearly and adapt the depth to the question.',
};

const LEVEL_GUIDE = {
  'Middle School': 'Use simple everyday words. Break the problem into small steps. Avoid jargon.',
  'High School': 'Use clear high-school vocabulary. Show important steps, formulas and reasoning.',
  College: 'Use college-level vocabulary. Include deeper theory and advanced reasoning where useful.',
};

const STYLE_GUIDE = {
  Short: 'Answer concisely. Lead with the key point and keep extras to a minimum.',
  Normal: 'Give a clear, balanced explanation with the important steps and an example when useful.',
  Detailed: 'Explain thoroughly. Include multiple examples, reasoning behind each step, and common mistakes to avoid.',
};

function buildSystemPrompt(schoolLevel, subject, answerStyle, language) {
  const parts = ['You are StudyBuddy AI, a friendly and encouraging tutor for students.'];

  if (subject && subject !== 'All Subjects') {
    parts.push(`You are tutoring ${subject}. ${SUBJECT_GUIDE[subject] ?? SUBJECT_GUIDE.Other}`);
  }

  parts.push(LEVEL_GUIDE[schoolLevel] ?? LEVEL_GUIDE['High School']);
  parts.push(STYLE_GUIDE[answerStyle] ?? STYLE_GUIDE.Normal);

  if (language && language !== 'English') {
    parts.push(
      `Write your entire answer in ${language}, at a natural native level a student would use. ` +
        'Keep mathematics, formulas, units and chemical symbols in their standard form, ' +
        `but write all prose in ${language}.`,
    );
  }

  parts.push(
    'Format with markdown: **bold** for key terms, short bullet lists, and numbered steps. ' +
      'Never state a fact you are unsure about. If a question is unclear, ask for clarification.',
  );

  return parts.join(' ');
}

/**
 * Every endpoint takes the same optional "language" field, so the prompt
 * builder always receives one even when the phone omits it.
 */
function readLanguage(body) {
  return body?.language ?? 'English';
}

function buildMessages(question, conversationHistory) {
  const messages = [];
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];

  // Only the most recent exchanges are needed for context.
  for (const msg of history.slice(-6)) {
    if (msg && msg.role && msg.content) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: String(msg.content).slice(0, 2000) });
    }
  }

  messages.push({ role: 'user', content: String(question ?? '').slice(0, 4000) });
  return messages;
}

function validateImage(image, mimeType) {
  if (!image || typeof image !== 'string') return 'Image is required.';
  if (mimeType && !ALLOWED_IMAGE_TYPES.includes(mimeType)) {
    return 'That file type is not supported. Please use a photo.';
  }
  if (image.length > MAX_IMAGE_BYTES) {
    return 'That image is too large. Please choose a smaller photo.';
  }
  return null;
}

// ---------- OpenRouter helpers ----------
function aiHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'HTTP-Referer': 'https://studybuddy.ai',
    'X-Title': 'StudyBuddy AI',
  };
}

function openAiRequest(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: aiHeaders(),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

/** Call the first text model that succeeds. */
async function callTextModel(systemPrompt, messages, maxTokens = 2000) {
  let lastError = 'AI unavailable';
  for (const model of TEXT_MODELS) {
    const response = await openAiRequest(
      { model, messages: [{ role: 'system', content: systemPrompt }, ...messages], max_tokens: maxTokens },
      REQUEST_TIMEOUT_MS,
    );
    if (response.ok) {
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return text;
      lastError = 'empty';
    } else {
      lastError = `status-${response.status}`;
    }
  }
  throw new Error(lastError);
}

/** Stream a text response, trying each model in order. */
async function streamText(systemPrompt, messages, res) {
  let lastError = 'AI unavailable';
  // A fallback chain must never turn into a long wait. Once this much time has
  // been spent the student gets an answer or a friendly error, never silence.
  const deadline = Date.now() + TOTAL_ATTEMPT_BUDGET_MS;

  for (const model of TEXT_MODELS) {
    if (Date.now() >= deadline) {
      console.error(`[text] budget exhausted after ${TEXT_MODELS.length} candidates`);
      break;
    }
    const controller = new AbortController();
    // Never let one model use the whole budget.
    // The timer must cover the whole attempt, not just the response headers.
    // Clearing it as soon as fetch resolves leaves a stream that then stalls
    // with no timeout at all, which is how a request could hang for minutes.
    const perModel = Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(), perModel);
    const startedAt = Date.now();
    let full = '';

    try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: aiHeaders(),
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Log why the provider refused. This never leaves the server: the phone
      // only ever receives the friendly message.
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 400);
      } catch {
        detail = '(body unreadable)';
      }
      console.error(`[upstream] ${model} -> ${response.status} ${detail}`);
      outcomes.push(`${model.split('/').pop().split(':')[0]}=${response.status}`);
      lastError = `status-${response.status}`;
      if (response.status === 429) await sleep(400);
      continue;
    }

    let firstTokenMs = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstTokenMs === null) {
              firstTokenMs = Date.now() - startedAt;
              console.log(`[timing] firstToken=${firstTokenMs}ms model=${model}`);
            }
            full += delta;
            res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
          }
        } catch {
          /* skip malformed frame */
        }
      }
    }

    if (full) {
      console.log(`[timing] complete=${Date.now() - startedAt}ms chars=${full.length} model=${model}`);
      return full;
    }
    console.error(`[upstream] ${model} returned an empty stream`);
    lastError = 'empty';
    } catch (err) {
      // If text already reached the student, hand back what we have rather
      // than discarding an answer they can already see.
      if (full) {
        console.error(`[text] ${model} stalled after ${full.length} chars, keeping partial`);
        return full;
      }
      if (err?.name === 'AbortError') {
        console.error(`[text] ${model} timed out after ${perModel}ms`);
        lastError = 'timeout';
      } else {
        console.error(`[text] ${model} failed: ${err?.message}`);
        lastError = 'error';
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(lastError);
}

/** Stream a vision response, trying each vision model in order. */
async function streamVision(base64Image, mimeType, systemPrompt, userText, res) {
  let lastError = 'AI unavailable';
  const deadline = Date.now() + TOTAL_ATTEMPT_BUDGET_MS;
  // Compact record of what each model did. Surfaced only in the diagnostic
  // "reason" field; the phone always renders its own friendly wording.
  const outcomes = [];

  for (const model of VISION_MODELS) {
    if (Date.now() >= deadline) {
      console.error('[vision] budget exhausted');
      break;
    }
    const controller = new AbortController();
    // As with text, this timer has to outlive the response headers.
    const perModel = Math.max(1000, Math.min(IMAGE_TIMEOUT_MS, deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(), perModel);
    const startedAt = Date.now();
    let full = '';

    try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: aiHeaders(),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            ],
          },
        ],
        stream: true,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Log why the provider refused. This never leaves the server: the phone
      // only ever receives the friendly message.
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 400);
      } catch {
        detail = '(body unreadable)';
      }
      console.error(`[upstream] ${model} -> ${response.status} ${detail}`);
      lastError = `status-${response.status}`;
      continue;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
          }
        } catch {
          /* skip */
        }
      }
    }

    if (full) {
      console.log(`[vision] used=${model} chars=${full.length} ms=${Date.now() - startedAt}`);
      return full;
    }
    console.error(`[upstream] ${model} returned an empty image stream`);
    outcomes.push(`${model.split('/').pop().split(':')[0]}=empty`);
    lastError = 'empty';
    } catch (err) {
      // Keep any partial reading rather than discarding work already on screen.
      if (full) {
        console.error(`[vision] ${model} stalled after ${full.length} chars, keeping partial`);
        return full;
      }
      if (err?.name === 'AbortError') {
        console.error(`[vision] ${model} timed out after ${perModel}ms`);
        lastError = 'timeout';
      } else {
        console.error(`[vision] ${model} failed: ${err?.message}`);
        lastError = 'error';
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Attach the per-model summary so the cause is visible without exposing any
  // provider detail to the student.
  if (outcomes.length) lastError = `${lastError}|${outcomes.join(',')}`;
  throw new Error(lastError);
}

/** Non-streaming vision call used as a fallback path. */
async function callVision(base64Image, mimeType, systemPrompt, userText) {
  let lastError = 'AI unavailable';

  for (const model of VISION_MODELS) {
    const response = await openAiRequest(
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            ],
          },
        ],
        max_tokens: 2000,
      },
      IMAGE_TIMEOUT_MS,
    );

    if (response.ok) {
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.trim()) return text;
      lastError = 'empty';
    } else {
      lastError = `status-${response.status}`;
    }
  }

  throw new Error(lastError);
}

// ---------- SSE helpers ----------
function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function streamError(res, message, reason) {
  try {
    // "reason" is a short machine-readable code for debugging. The app never
    // shows it: it always renders the friendly "message" text, so no provider
    // detail can reach a student.
    const frame = reason ? { error: message, reason } : { error: message };
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end();
  } catch {
    /* client already gone */
  }
}

/**
 * Turns a thrown error into a stable code, including the upstream HTTP status
 * when there is one, so a failure can be diagnosed from the outside without
 * leaking provider detail to the phone.
 */
/** Waits without needing a timer library. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorReason(err) {
  const raw = String(err?.message ?? '');
  const status = raw.match(/status-(\d{3})/);
  // Keep the "|model=status,..." summary the vision chain attaches, otherwise
  // the reason that tells us which models failed is thrown away.
  if (status) {
    const summary = raw.includes('|') ? `|${raw.split('|').slice(1).join('|')}` : '';
    return `UPSTREAM_${status[1]}${summary}`;
  }
  if (raw.includes('empty')) return 'EMPTY_RESPONSE';
  if (raw.includes('timeout')) return 'TIMEOUT';
  if (raw.includes('error')) return 'NETWORK_ERROR';
  return 'UNKNOWN';
}

function friendlyProviderError(err) {
  const msg = String(err?.message ?? '');
  if (msg.includes('429') || msg.includes('status-429')) {
    return 'StudyBuddy is busy right now. Please try again.';
  }
  if (err?.name === 'AbortError' || msg.includes('aborted')) {
    return 'StudyBuddy is taking longer than usual. Please try again.';
  }
  return 'StudyBuddy is having trouble right now. Please try again.';
}

const PHOTO_INSTRUCTION =
  'Read this homework photo. First state what the question asks. Then solve it showing each step. ' +
  'Finish with the final answer clearly labelled. If the text is unreadable, say so plainly.';

// ---------- Streaming endpoints ----------
app.post('/api/chat/stream', async (req, res) => {
  setupSSE(res);
  const { question, subject = null, schoolLevel, answerStyle, conversationHistory = [] } = req.body ?? {};
  if (!question) return streamError(res, 'Question is required.');

  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const messages = buildMessages(question, conversationHistory);
    const text = await streamText(prompt, messages, res);
    res.write(`data: ${JSON.stringify({ done: true, chars: text.length })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[chat/stream]', err?.message);
    streamError(res, friendlyProviderError(err), errorReason(err));
  }
});

app.post('/api/quick-action/stream', async (req, res) => {
  setupSSE(res);
  const { action, conversationHistory = [], subject = null, schoolLevel, answerStyle } = req.body ?? {};

  const ACTIONS = {
    simpler: 'Explain that again in much simpler words. Use one easy analogy and shorter sentences.',
    steps: 'Show the steps for that problem, one numbered step at a time.',
    example: 'Give a clear worked example of that idea.',
    quiz: 'Write 3 short quiz questions on that topic with their answers listed at the end.',
    practice: 'Write 3 practice problems on that topic. Do not include the answers yet.',
    confused: 'Explain that a different way, using a different approach or analogy.',
  };

  const followUp = ACTIONS[action];
  if (!followUp) return streamError(res, 'That action is not available.');

  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const messages = buildMessages(followUp, conversationHistory);
    const text = await streamText(prompt, messages, res);
    res.write(`data: ${JSON.stringify({ done: true, chars: text.length })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[quick-action/stream]', err?.message);
    streamError(res, friendlyProviderError(err), errorReason(err));
  }
});

app.post('/api/solve-photo/stream', async (req, res) => {
  setupSSE(res);
  const { image, mimeType, subject = null, schoolLevel, answerStyle, question } = req.body ?? {};

  const invalid = validateImage(image, mimeType);
  if (invalid) return streamError(res, invalid);

  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const userText = question?.trim()
      ? `${PHOTO_INSTRUCTION}\n\nThe student asks: ${String(question).slice(0, 1000)}`
      : PHOTO_INSTRUCTION;

    const text = await streamVision(image, mimeType, prompt, userText, res);
    res.write(`data: ${JSON.stringify({ done: true, chars: text.length })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[solve-photo/stream]', err?.message);
    streamError(res, friendlyProviderError(err), errorReason(err));
  }
});

// ---------- Non-streaming endpoints ----------
app.post('/api/ask', async (req, res) => {
  const { question, subject = null, schoolLevel, answerStyle, conversationHistory = [] } = req.body ?? {};
  if (!question) return res.status(400).json({ error: 'Question is required.' });
  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const text = await callTextModel(prompt, buildMessages(question, conversationHistory));
    res.json({ response: text });
  } catch (err) {
    console.error('[ask]', err?.message);
    res.status(500).json({ error: friendlyProviderError(err) });
  }
});

app.post('/api/solve-photo', async (req, res) => {
  const { image, mimeType, subject = null, schoolLevel, answerStyle, question } = req.body ?? {};
  const invalid = validateImage(image, mimeType);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const userText = question?.trim()
      ? `${PHOTO_INSTRUCTION}\n\nThe student asks: ${String(question).slice(0, 1000)}`
      : PHOTO_INSTRUCTION;
    const text = await callVision(image, mimeType, prompt, userText);
    res.json({ response: text });
  } catch (err) {
    console.error('[solve-photo]', err?.message);
    res.status(500).json({ error: friendlyProviderError(err) });
  }
});

app.post('/api/flashcards', async (req, res) => {
  const { topic, subject = null, schoolLevel, answerStyle } = req.body ?? {};
  if (!topic) return res.status(400).json({ error: 'Topic is required.' });
  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const text = await callTextModel(
      prompt,
      [
        {
          role: 'user',
          content:
            `Create 5 study flashcards about "${String(topic).slice(0, 500)}". ` +
            'Reply with ONLY valid JSON in this exact shape and no other text: ' +
            '{"flashcards":[{"front":"Question?","back":"Answer."}]}. ' +
            'Keep each answer under 25 words.',
        },
      ],
      1500,
    );
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('parse');
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('[flashcards]', err?.message);
    res.status(500).json({ error: 'Could not create flashcards right now. Please try again.' });
  }
});

app.post('/api/quiz', async (req, res) => {
  const { topic, subject = null, schoolLevel, answerStyle } = req.body ?? {};
  if (!topic) return res.status(400).json({ error: 'Topic is required.' });
  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const text = await callTextModel(
      prompt,
      [
        {
          role: 'user',
          content:
            `Create 5 multiple-choice questions about "${String(topic).slice(0, 500)}". ` +
            'Reply with ONLY valid JSON: ' +
            '{"questions":[{"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}]}. ' +
            'Exactly one option is correct. correctIndex is 0-based.',
        },
      ],
      1500,
    );
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('parse');
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('[quiz]', err?.message);
    res.status(500).json({ error: 'Could not create a quiz right now. Please try again.' });
  }
});

app.post('/api/explain', async (req, res) => {
  const { topic, subject = null, schoolLevel, answerStyle } = req.body ?? {};
  if (!topic) return res.status(400).json({ error: 'Topic is required.' });
  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const text = await callTextModel(prompt, [
      { role: 'user', content: `Explain "${String(topic).slice(0, 500)}". Start with a one-sentence definition, then break it into key ideas.` },
    ]);
    res.json({ response: text });
  } catch (err) {
    console.error('[explain]', err?.message);
    res.status(500).json({ error: friendlyProviderError(err) });
  }
});

app.post('/api/summarize', async (req, res) => {
  const { notes, subject = null, schoolLevel, answerStyle } = req.body ?? {};
  if (!notes) return res.status(400).json({ error: 'Notes are required.' });
  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const text = await callTextModel(
      prompt,
      [
        {
          role: 'user',
          content:
            `Summarize these notes into clear key points.\n\n${String(notes).slice(0, 6000)}`,
        },
      ],
      2000,
    );
    res.json({ response: text });
  } catch (err) {
    console.error('[summarize]', err?.message);
    res.status(500).json({ error: friendlyProviderError(err) });
  }
});

app.post('/api/practice-problems', async (req, res) => {
  const { subject = null, schoolLevel, answerStyle } = req.body ?? {};
  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const topic = subject ? ` about ${subject}` : '';
    const text = await callTextModel(
      prompt,
      [
        {
          role: 'user',
          content:
            `Create 5 practice problems${topic} that require a written answer. ` +
            'Reply with ONLY valid JSON: ' +
            '{"problems":[{"question":"...","hint":"..."}]}. ' +
            'Do not include answers.',
        },
      ],
      1500,
    );
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('parse');
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('[practice-problems]', err?.message);
    res.status(500).json({ error: 'Could not create practice problems right now.' });
  }
});

const WRITING_TASKS = {
  'grammar-check': 'Find every grammar and spelling mistake. For each one, show the original, the correction, and a one-line reason.',
  'improve-writing':
    'Rewrite the text so it is clearer and more polished, keeping the student\'s own voice and meaning. Show the improved version, then list what you changed and why.',
  'structure':
    'Suggest a clear structure for this text: an opening, main points in the best order, and a conclusion. Give a short outline the student can follow.',
  'thesis':
    'Help write one strong thesis statement. Offer three different options at different levels of directness, then explain which is strongest and why.',
  'counter-argument':
    'Give the strongest counter-argument to the main claim in this text, then suggest how the student could address it honestly.',
  'simplify': 'Rewrite this text in simpler language so a younger student could follow it. Keep the meaning accurate.',
  'transition':
    'Suggest smooth transition sentences to connect these ideas in order. Give one option per gap and explain the effect.',
};

app.post('/api/writing-assistant', async (req, res) => {
  const { text, task, subject = null, schoolLevel, answerStyle } = req.body ?? {};

  const trimmed = String(text ?? '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Please paste or type some text first.' });
  if (trimmed.length > 8000) {
    return res.status(400).json({ error: 'That text is too long. Try a smaller section.' });
  }

  const instruction = WRITING_TASKS[task];
  if (!instruction) return res.status(400).json({ error: 'That writing task is not available.' });

  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
    const answer = await callTextModel(
      `${prompt} You are helping a student improve their own writing. Be encouraging and specific. ` +
        'Never rewrite it as finished homework the student could submit as-is: teach and guide instead. ' +
        'Use markdown with short sections.',
      [
        {
          role: 'user',
          content: `${instruction}\n\nStudent's text:\n"""\n${trimmed}\n"""`,
        },
      ],
      1800,
    );

    res.json({ response: answer });
  } catch (err) {
    console.error('[writing-assistant]', err?.message);
    res.status(500).json({ error: friendlyProviderError(err) });
  }
});

app.post('/api/check-answer', async (req, res) => {
  const { question, answer, subject = null, schoolLevel } = req.body ?? {};
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required.' });
  try {
    const prompt = buildSystemPrompt(schoolLevel, subject, 'Short', readLanguage(req.body));
    const text = await callTextModel(
      prompt,
      [
        {
          role: 'user',
          content:
            `Check this answer.\n\nProblem: ${String(question).slice(0, 1000)}\n` +
            `Student answer: ${String(answer).slice(0, 500)}\n\n` +
            'Reply with ONLY valid JSON: ' +
            '{"isCorrect":true,"explanation":"...","correctAnswer":"..."}. ' +
            'Accept equivalent answers. Be encouraging.',
        },
      ],
      600,
    );
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('parse');
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('[check-answer]', err?.message);
    res.status(500).json({ error: 'Could not check that answer right now.' });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`StudyBuddy AI server on port ${PORT}`);
  console.log(`Text model: ${OPENROUTER_MODEL}`);
  console.log(`Key configured: ${!!OPENROUTER_API_KEY}`);
});
