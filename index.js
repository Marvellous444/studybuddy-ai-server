require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// AI provider configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || 'qwen/qwen3.8-27b:free';

// Request timeout (30 seconds)
const REQUEST_TIMEOUT = 30000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 10MB is enough for compressed homework photos

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'StudyBuddy AI' });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    configured: !!OPENROUTER_API_KEY,
    model: OPENROUTER_MODEL,
  });
});

// ============ COMPACT PROMPT BUILDER ============

function buildSystemPrompt(schoolLevel, subject, answerStyle) {
  // Short subject labels - keep the prompt tiny for speed
  const subjectLabel = subject && subject !== 'All Subjects' ? subject : null;
  const levelLabel = schoolLevel || 'High School';
  const styleLabel = answerStyle || 'Normal';

  let prompt = `You are StudyBuddy AI, a friendly tutor. Answer the student's question clearly.`;

  if (subjectLabel) {
    prompt += ` You are a ${subjectLabel} tutor.`;
  }

  // Level guidance - one line each
  if (levelLabel === 'Middle School') {
    prompt += ` Use simple words and small steps.`;
  } else if (levelLabel === 'College') {
    prompt += ` Use college-level concepts and deeper reasoning.`;
  } else {
    prompt += ` Use clear high-school level explanations.`;
  }

  // Style guidance - one line each
  if (styleLabel === 'Short') {
    prompt += ` Answer concisely.`;
  } else if (styleLabel === 'Detailed') {
    prompt += ` Give a thorough explanation with steps and examples.`;
  } else {
    prompt += ` Give a clear, balanced answer.`;
  }

  prompt += ` Use **bold** for key terms, bullet points for lists, and numbered steps for processes.`;

  return prompt;
}

// Build messages - only keep last 6 messages for context (keeps requests small)
function buildMessages(question, conversationHistory) {
  const messages = [];
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];

  // Keep only the last 6 messages to minimize request size
  const recentHistory = history.slice(-6);

  for (const msg of recentHistory) {
    if (msg && msg.role && msg.content) {
      messages.push({ role: msg.role, content: String(msg.content).slice(0, 2000) });
    }
  }

  // Truncate question to reasonable length
  messages.push({ role: 'user', content: String(question).slice(0, 4000) });
  return messages;
}

// ============ STREAMING AI CALL ============

async function streamOpenRouter(systemPrompt, messages, res, startTime) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('AI service is not configured');
  }

  const aiStartTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://studybuddy.ai',
      'X-Title': 'StudyBuddy AI',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      stream: true, // Enable streaming
      max_tokens: 2000, // Limit response length for speed
    }),
    signal: controller.signal,
  });

  if (!response.ok) {
    clearTimeout(timeout);
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `AI request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstTokenTime = null;
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed?.choices?.[0]?.delta?.content;

        if (delta) {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            // Timing log (safe - no secrets)
            console.log(`[timing] aiStart: ${aiStartTime - startTime}ms, firstToken: ${firstTokenTime - startTime}ms`);
          }

          fullText += delta;
          // Send as Server-Sent Events format
          res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  clearTimeout(timeout);

  const completeTime = Date.now();
  console.log(`[timing] complete: ${completeTime - startTime}ms, chars: ${fullText.length}`);

  // Send done signal
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();

  return fullText;
}

// Stream with image
async function streamOpenRouterWithImage(base64Image, mimeType, systemPrompt, messages, res, startTime) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('AI service is not configured');
  }

  const aiStartTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000); // Images take longer

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://studybuddy.ai',
      'X-Title': 'StudyBuddy AI',
    },
    body: JSON.stringify({
      model: OPENROUTER_VISION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
        {
          role: 'user',
          content: [
            { type: 'text', text: messages[messages.length - 1]?.content || 'Solve this homework.' },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
      stream: true,
      max_tokens: 2000,
    }),
    signal: controller.signal,
  });

  if (!response.ok) {
    clearTimeout(timeout);
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `AI request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstTokenTime = null;
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed?.choices?.[0]?.delta?.content;

        if (delta) {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            console.log(`[timing] aiStart: ${aiStartTime - startTime}ms, firstToken: ${firstTokenTime - startTime}ms`);
          }

          fullText += delta;
          res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  clearTimeout(timeout);
  console.log(`[timing] complete: ${Date.now() - startTime}ms, chars: ${fullText.length}`);

  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();

  return fullText;
}

// ============ SSE HELPER ============

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();
}

function sendError(res, message) {
  try {
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  } catch {
    // Connection already closed
  }
}

// ============ STREAMING ENDPOINTS ============

// Streaming ask
app.post('/api/ask/stream', async (req, res) => {
  const startTime = Date.now();
  setupSSE(res);

  try {
    const { question, subject = null, schoolLevel = 'High School', answerStyle = 'Normal', conversationHistory = [] } = req.body;
    if (!question) {
      return sendError(res, 'Question is required');
    }

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const messages = buildMessages(question, conversationHistory);

    await streamOpenRouter(systemPrompt, messages, res, startTime);
  } catch (error) {
    console.error(`[error] ask/stream: ${error.message}`);
    sendError(res, 'StudyBuddy is having trouble right now. Please try again.');
  }
});

// Streaming chat
app.post('/api/chat/stream', async (req, res) => {
  const startTime = Date.now();
  setupSSE(res);

  try {
    const { question, subject = null, schoolLevel = 'High School', answerStyle = 'Normal', conversationHistory = [] } = req.body;
    if (!question) {
      return sendError(res, 'Question is required');
    }

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const messages = buildMessages(question, conversationHistory);

    await streamOpenRouter(systemPrompt, messages, res, startTime);
  } catch (error) {
    console.error(`[error] chat/stream: ${error.message}`);
    sendError(res, 'StudyBuddy is having trouble right now. Please try again.');
  }
});

// Streaming quick action
app.post('/api/quick-action/stream', async (req, res) => {
  const startTime = Date.now();
  setupSSE(res);

  try {
    const { action, conversationHistory = [], subject = null, schoolLevel = 'High School', answerStyle = 'Normal' } = req.body;

    const actionPrompts = {
      simpler: 'Explain that again in simpler terms with an easier example.',
      steps: 'Show the steps for that problem clearly.',
      example: 'Give a clear example of that concept.',
      quiz: 'Give me a short quiz with 3 questions on that topic.',
      practice: 'Give me 3 practice problems on that topic.',
      confused: 'Explain that differently, using an analogy.',
    };

    const question = actionPrompts[action];
    if (!question) {
      return sendError(res, 'Invalid action');
    }

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const messages = buildMessages(question, conversationHistory);

    await streamOpenRouter(systemPrompt, messages, res, startTime);
  } catch (error) {
    console.error(`[error] quick-action/stream: ${error.message}`);
    sendError(res, 'StudyBuddy is having trouble right now. Please try again.');
  }
});

// Streaming photo solve
app.post('/api/solve-photo/stream', async (req, res) => {
  const startTime = Date.now();
  setupSSE(res);

  try {
    const { image, mimeType, subject = null, schoolLevel = 'High School', answerStyle = 'Normal', question = '' } = req.body;
    if (!image) {
      return sendError(res, 'Image is required');
    }

    // Validate image type
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
    if (mimeType && !validTypes.includes(mimeType)) {
      return sendError(res, 'That file type is not supported. Please use a photo.');
    }

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const photoPrompt = `Read this homework photo and help solve it. First identify the question, then explain the solution step by step, then give the final answer. If the image is too blurry, say "I couldn't read this photo clearly. Please take a clearer picture."`;

    const messages = [];
    if (question) {
      messages.push({ role: 'user', content: question });
    } else {
      messages.push({ role: 'user', content: 'Solve this homework.' });
    }

    await streamOpenRouterWithImage(image, mimeType, systemPrompt, messages, res, startTime);
  } catch (error) {
    console.error(`[error] solve-photo/stream: ${error.message}`);
    sendError(res, 'StudyBuddy could not read your photo. Please try again.');
  }
});

// Debug endpoint - tests vision model with a tiny image
app.post('/api/debug-vision', async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.json({ error: 'No API key' });

  const tinyImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_VISION_MODEL,
        messages: [
          { role: 'user', content: [
            { type: 'text', text: 'What color is this?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyImage}` } },
          ]},
        ],
        max_tokens: 50,
      }),
    });

    const status = response.status;
    const data = await response.json().catch(() => ({}));
    res.json({ status, model: OPENROUTER_VISION_MODEL, ok: response.ok, response: data });
  } catch (error) {
    res.json({ error: error.message, model: OPENROUTER_VISION_MODEL });
  }
});

// ============ NON-STREAMING ENDPOINTS (for JSON responses) ============

// Solve photo (non-streaming - used by photo solver screen)
app.post('/api/solve-photo', async (req, res) => {
  try {
    const { image, mimeType, subject = null, schoolLevel = 'High School', answerStyle = 'Normal', question = '' } = req.body;
    if (!image) return res.status(400).json({ error: 'Image is required' });
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service is temporarily unavailable' });

    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
    if (mimeType && !validTypes.includes(mimeType)) {
      return res.status(400).json({ error: 'That file type is not supported. Please use a photo.' });
    }

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const photoPrompt = `Read this homework photo and help solve it. First identify the question, then explain the solution step by step, then give the final answer. If the image is too blurry, say "I couldn't read this photo clearly. Please take a clearer picture."`;

    const userText = question || 'Solve this homework.';

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_VISION_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: photoPrompt + '\n\n' + userText },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${image}` },
              },
            ],
          },
        ],
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error(`[error] solve-photo OpenRouter: ${errData?.error?.message || response.status}`);
      throw new Error(errData?.error?.message || `AI request failed (${response.status})`);
    }
    const data = await response.json();
    res.json({ response: data?.choices?.[0]?.message?.content || 'No response.' });
  } catch (error) {
    console.error(`[error] solve-photo: ${error.message}`);
    res.status(500).json({ error: 'StudyBuddy could not read your photo. Please try again.' });
  }
});

// Ask AI
app.post('/api/ask', async (req, res) => {
  const startTime = Date.now();
  try {
    const { question, subject = null, schoolLevel = 'High School', answerStyle = 'Normal', conversationHistory = [] } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });

    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'AI service is temporarily unavailable' });
    }

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const messages = buildMessages(question, conversationHistory);

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        max_tokens: 2000,
      }),
    });

    if (!response.ok) throw new Error('AI request failed');
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || 'No response generated.';

    console.log(`[timing] non-stream ask: ${Date.now() - startTime}ms`);
    res.json({ response: text });
  } catch (error) {
    console.error(`[error] ask: ${error.message}`);
    res.status(500).json({ error: 'StudyBuddy is having trouble right now. Please try again.' });
  }
});

// Generate flashcards
app.post('/api/flashcards', async (req, res) => {
  try {
    const { topic, subject = null, schoolLevel = 'High School', answerStyle = 'Normal' } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service is temporarily unavailable' });

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const prompt = `Create 5 study flashcards about "${topic}". Respond with ONLY valid JSON: {"flashcards":[{"front":"Question?","back":"Answer."}]}`;

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1500,
      }),
    });

    if (!response.ok) throw new Error('AI request failed');
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse flashcards');
    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ flashcards: parsed.flashcards });
  } catch (error) {
    console.error(`[error] flashcards: ${error.message}`);
    res.status(500).json({ error: 'Failed to generate flashcards. Please try again.' });
  }
});

// Generate quiz
app.post('/api/quiz', async (req, res) => {
  try {
    const { topic, subject = null, schoolLevel = 'High School', answerStyle = 'Normal' } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service is temporarily unavailable' });

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const prompt = `Create 5 multiple-choice questions about "${topic}". Respond with ONLY valid JSON: {"questions":[{"question":"Q?","options":["A","B","C","D"],"correctIndex":0,"explanation":"Why."}]}`;

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1500,
      }),
    });

    if (!response.ok) throw new Error('AI request failed');
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse quiz');
    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ questions: parsed.questions });
  } catch (error) {
    console.error(`[error] quiz: ${error.message}`);
    res.status(500).json({ error: 'Failed to generate quiz. Please try again.' });
  }
});

// Explain topic
app.post('/api/explain', async (req, res) => {
  try {
    const { topic, subject = null, schoolLevel = 'High School', answerStyle = 'Normal' } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service is temporarily unavailable' });

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Explain "${topic}". Start with a simple definition, then break it into key concepts.` },
        ],
        max_tokens: 2000,
      }),
    });

    if (!response.ok) throw new Error('AI request failed');
    const data = await response.json();
    res.json({ response: data?.choices?.[0]?.message?.content || 'No response.' });
  } catch (error) {
    console.error(`[error] explain: ${error.message}`);
    res.status(500).json({ error: 'Failed to explain topic. Please try again.' });
  }
});

// Summarize notes
app.post('/api/summarize', async (req, res) => {
  try {
    const { notes, subject = null, schoolLevel = 'High School', answerStyle = 'Normal' } = req.body;
    if (!notes) return res.status(400).json({ error: 'Notes are required' });
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service is temporarily unavailable' });

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Summarize these notes. Keep key points organized:\n\n${String(notes).slice(0, 6000)}` },
        ],
        max_tokens: 2000,
      }),
    });

    if (!response.ok) throw new Error('AI request failed');
    const data = await response.json();
    res.json({ response: data?.choices?.[0]?.message?.content || 'No response.' });
  } catch (error) {
    console.error(`[error] summarize: ${error.message}`);
    res.status(500).json({ error: 'Failed to summarize notes. Please try again.' });
  }
});

// Practice problems
app.post('/api/practice-problems', async (req, res) => {
  try {
    const { subject = null, schoolLevel = 'High School', answerStyle = 'Normal' } = req.body;
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service is temporarily unavailable' });

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, answerStyle);
    const subjectContext = subject ? ` about ${subject}` : '';
    const prompt = `Create 5 practice problems${subjectContext}. Respond with ONLY valid JSON: {"problems":[{"question":"Problem text","hint":"Optional hint"}]}`;

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1500,
      }),
    });

    if (!response.ok) throw new Error('AI request failed');
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse problems');
    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ problems: parsed.problems });
  } catch (error) {
    console.error(`[error] practice-problems: ${error.message}`);
    res.status(500).json({ error: 'Failed to generate practice problems. Please try again.' });
  }
});

// Check answer
app.post('/api/check-answer', async (req, res) => {
  try {
    const { question, answer, subject = null, schoolLevel = 'High School' } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service is temporarily unavailable' });

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, 'Short');
    const prompt = `Check this answer. Respond with ONLY valid JSON: {"isCorrect":true,"explanation":"Why","correctAnswer":"Answer"}

Problem: ${question}
Student answer: ${answer}`;

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
      }),
    });

    if (!response.ok) throw new Error('AI request failed');
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse result');
    res.json(JSON.parse(jsonMatch[0]));
  } catch (error) {
    console.error(`[error] check-answer: ${error.message}`);
    res.status(500).json({ error: 'Failed to check answer. Please try again.' });
  }
});

// Study plan
app.post('/api/study-plan', async (req, res) => {
  try {
    const { subject = null, topic, date, availableTime, schoolLevel = 'High School' } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service is temporarily unavailable' });

    const systemPrompt = buildSystemPrompt(schoolLevel, subject, 'Detailed');

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://studybuddy.ai',
        'X-Title': 'StudyBuddy AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Create a study plan. Subject: ${subject || 'General'}. Topic: ${topic}. Date: ${date || 'N/A'}. Study time: ${availableTime || 'N/A'}.` },
        ],
        max_tokens: 1500,
      }),
    });

    if (!response.ok) throw new Error('AI request failed');
    const data = await response.json();
    res.json({ response: data?.choices?.[0]?.message?.content || 'No response.' });
  } catch (error) {
    console.error(`[error] study-plan: ${error.message}`);
    res.status(500).json({ error: 'Failed to create study plan. Please try again.' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`StudyBuddy AI Server on port ${PORT}`);
  console.log(`Model: ${OPENROUTER_MODEL}`);
  console.log(`Key configured: ${!!OPENROUTER_API_KEY}`);
});
