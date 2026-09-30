require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// OpenRouter API configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'StudyBuddy AI Server is running' });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apiKeyConfigured: !!OPENROUTER_API_KEY,
    model: OPENROUTER_MODEL,
    envKeys: Object.keys(process.env).filter(k => k.includes('OPENROUTER') || k.includes('API')),
    hasDotenv: typeof process.env.OPENROUTER_API_KEY !== 'undefined',
  });
});

// Call OpenRouter API
async function callOpenRouter(systemPrompt, messages) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured on the server');
  }

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
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `API request failed with status ${response.status}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || 'No response generated.';
}

// Call OpenRouter with image
async function callOpenRouterWithImage(base64Image, mimeType, systemPrompt, messages) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured on the server');
  }

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
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the homework image:' },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `API request failed with status ${response.status}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || 'No response generated.';
}

// Build system prompt based on level and subject
function buildSystemPrompt(level, subject) {
  const basePrompt = `You are StudyBuddy AI, a friendly and helpful study assistant for students. Your job is to help students learn and understand topics, not just give them answers.

IMPORTANT RULES:
- Always explain things in simple, easy-to-understand language
- Teach concepts step by step
- Give examples when helpful
- If the question is unclear, ask for clarification
- Never make up facts - if you're not sure, say so
- Encourage critical thinking
- Be friendly and supportive

Level-specific instructions:
${level === 'elementary'
  ? '- Use very simple words a 6-10 year old would understand\n- Use fun examples from everyday life\n- Keep explanations short and simple'
  : level === 'middle'
    ? '- Use clear language a 11-13 year old would understand\n- Use relatable examples\n- Show step-by-step reasoning\n- Define any technical terms'
    : '- Use appropriate language for high school students (14-18)\n- Show detailed reasoning\n- Include relevant formulas or concepts when applicable\n- Explain the "why" behind concepts'}

Format your responses with markdown-style formatting:
- Use **bold** for important terms
- Use bullet points for lists
- Use numbered steps for processes
- Use line breaks to separate ideas`;

  if (subject && subject !== 'All Subjects') {
    const subjectPrompts = {
      'Math': 'You are a Math tutor. Show equations, explain each step clearly, and always give the final answer.',
      'Science': 'You are a Science tutor. Explain concepts accurately, use correct scientific terminology.',
      'Chemistry': 'You are a Chemistry tutor. Help with atoms, elements, periodic table, chemical formulas, balancing equations, reactions, moles, molar mass, stoichiometry, acids and bases, solutions, bonding, and lab questions.',
      'English': 'You are an English tutor. Help with grammar, writing, reading comprehension, and literature analysis.',
      'History': 'You are a History tutor. Explain historical events, important people, causes and effects, and timelines.',
      'Geography': 'You are a Geography tutor. Explain locations, physical and human geography, and help with maps.',
      'Computer Science': 'You are a Computer Science tutor. Explain programming concepts, algorithms, and help with debugging.',
      'Languages': 'You are a Languages tutor. Help with vocabulary, grammar, conversation practice, and cultural context.',
      'Engineering': 'You are an Engineering tutor. Explain engineering concepts, calculations, and design principles.',
      'Art': 'You are an Art tutor. Explain techniques, art history, and help with analysis.',
      'Music': 'You are a Music tutor. Explain music theory, notation, history, and help with composition.',
      'Economics': 'You are an Economics tutor. Explain economic concepts, models, and analysis.',
      'Psychology': 'You are a Psychology tutor. Explain psychological concepts, theories, and research findings.',
      'Other': 'You are a general academic tutor. Provide helpful, accurate information across various subjects.',
    };

    const subjectPrompt = subjectPrompts[subject] || subjectPrompts['Other'];
    return `${basePrompt}\n\nSubject-specific instructions:\n${subjectPrompt}`;
  }

  return basePrompt;
}

// Helper to build messages array with conversation history
function buildMessages(question, conversationHistory) {
  const messages = [];
  for (const msg of conversationHistory || []) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

// ============ API Endpoints ============

// Ask AI
app.post('/api/ask', async (req, res) => {
  try {
    const { question, level = 'middle', subject = null, conversationHistory = [] } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const messages = buildMessages(question, conversationHistory);
    const response = await callOpenRouter(systemPrompt, messages);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat (same as ask but explicit)
app.post('/api/chat', async (req, res) => {
  try {
    const { question, level = 'middle', subject = null, conversationHistory = [] } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const messages = buildMessages(question, conversationHistory);
    const response = await callOpenRouter(systemPrompt, messages);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Quick action
app.post('/api/quick-action', async (req, res) => {
  try {
    const { action, conversationHistory = [], subject = null, level = 'middle' } = req.body;

    const actionPrompts = {
      simpler: 'Can you explain that in simpler terms? Use easier words and smaller steps.',
      steps: 'Can you show me the steps to solve this?',
      example: 'Can you give me an example to help me understand?',
      quiz: 'Can you give me a quiz on this topic? Ask me questions one at a time.',
      practice: 'Can you give me practice problems to work on?',
      confused: "I'm still confused. Can you explain that differently? Use a different approach or analogy.",
    };

    const question = actionPrompts[action];
    if (!question) return res.status(400).json({ error: 'Invalid action' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const messages = buildMessages(question, conversationHistory);
    const response = await callOpenRouter(systemPrompt, messages);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate flashcards
app.post('/api/flashcards', async (req, res) => {
  try {
    const { topic, level = 'middle', subject = null } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const prompt = `Create 5 study flashcards about "${topic}".

IMPORTANT: Respond with ONLY valid JSON in this exact format, no other text:
{
  "flashcards": [
    { "front": "Question text?", "back": "Answer text." }
  ]
}

Make sure:
- Questions are clear and specific
- Answers are concise but complete
- The flashcards cover the most important aspects of the topic`;

    const response = await callOpenRouter(systemPrompt, [{ role: 'user', content: prompt }]);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Failed to generate flashcards' });

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ flashcards: parsed.flashcards });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate quiz
app.post('/api/quiz', async (req, res) => {
  try {
    const { topic, level = 'middle', subject = null } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const prompt = `Create a short quiz with 5 multiple-choice questions about "${topic}".

IMPORTANT: Respond with ONLY valid JSON in this exact format, no other text:
{
  "questions": [
    {
      "question": "Question text?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "explanation": "Brief explanation of why this is correct."
    }
  ]
}

Make sure:
- Questions test understanding, not just memorization
- All 4 options are plausible but only one is correct
- correctIndex is 0-based (0 = first option)`;

    const response = await callOpenRouter(systemPrompt, [{ role: 'user', content: prompt }]);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Failed to generate quiz' });

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ questions: parsed.questions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Explain topic
app.post('/api/explain', async (req, res) => {
  try {
    const { topic, level = 'middle', subject = null } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const prompt = `Explain the topic "${topic}" in detail. Start with a simple definition, then break it down into key concepts.`;
    const response = await callOpenRouter(systemPrompt, [{ role: 'user', content: prompt }]);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Summarize notes
app.post('/api/summarize', async (req, res) => {
  try {
    const { notes, level = 'middle', subject = null } = req.body;
    if (!notes) return res.status(400).json({ error: 'Notes are required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const prompt = `Summarize the following study notes. Keep the most important points and organize them clearly:\n\n${notes}`;
    const response = await callOpenRouter(systemPrompt, [{ role: 'user', content: prompt }]);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Solve photo
app.post('/api/solve-photo', async (req, res) => {
  try {
    const { image, mimeType, level = 'middle', subject = null, question = '' } = req.body;
    if (!image) return res.status(400).json({ error: 'Image is required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const photoPrompt = `Look at this homework question in the image and help the student solve it.

Please:
1. Identify the question - Read and transcribe the question from the image
2. Explain how to solve it step by step - Show all work clearly
3. Give the final answer - Clearly state the answer

Guidelines:
- For math problems: Show the equation, explain each step, and give the final answer
- For science questions: Explain the concept, give examples, and provide the answer
- For English questions: Explain the passage or question clearly, then help answer it
- If the image is blurry or unreadable, say "The image appears to be blurry. Please take a clearer photo."
- If no question is detected, say "I couldn't find a homework question in this image. Please try again with a clearer photo."
- Be encouraging and supportive!`;

    const finalPrompt = question ? `${photoPrompt}\n\nAdditional context from student: ${question}` : photoPrompt;
    const response = await callOpenRouterWithImage(image, mimeType, systemPrompt, [{ role: 'user', content: finalPrompt }]);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Practice problems
app.post('/api/practice-problems', async (req, res) => {
  try {
    const { subject = null, level = 'middle' } = req.body;

    const systemPrompt = buildSystemPrompt(level, subject);
    const subjectContext = subject ? ` Create problems specifically about ${subject}.` : '';
    const prompt = `Create 5 practice problems for a student to solve.${subjectContext}

IMPORTANT: Respond with ONLY valid JSON in this exact format, no other text:
{
  "problems": [
    {
      "question": "Problem statement that requires a written answer",
      "hint": "A helpful hint to guide the student"
    }
  ]
}

Make sure:
- Problems require written answers (not multiple choice)
- Problems test understanding and application of concepts
- Each problem is clear and unambiguous`;

    const response = await callOpenRouter(systemPrompt, [{ role: 'user', content: prompt }]);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Failed to generate practice problems' });

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ problems: parsed.problems });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check answer
app.post('/api/check-answer', async (req, res) => {
  try {
    const { question, answer, subject = null, level = 'middle' } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const prompt = `You are checking a student's answer to a practice problem.

Problem: ${question}
Student's answer: ${answer}

Evaluate the student's answer and respond with ONLY valid JSON in this exact format:
{
  "isCorrect": true/false,
  "explanation": "Brief explanation of why the answer is correct or incorrect",
  "correctAnswer": "The correct answer (or a model answer)"
}

Guidelines:
- Be encouraging and supportive
- If the answer is partially correct, mark it as incorrect but explain what was right
- Provide a clear, concise correct answer`;

    const response = await callOpenRouter(systemPrompt, [{ role: 'user', content: prompt }]);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Failed to check answer' });

    const parsed = JSON.parse(jsonMatch[0]);
    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Study plan
app.post('/api/study-plan', async (req, res) => {
  try {
    const { subject = null, topic, date, availableTime, level = 'middle' } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });

    const systemPrompt = buildSystemPrompt(level, subject);
    const prompt = `Create a study plan for the student.

Subject: ${subject || 'General'}
Topic: ${topic}
Test/Exam date: ${date || 'Not specified'}
Available study time: ${availableTime || 'Not specified'}

Create a realistic, organized study plan. Keep it flexible and encouraging. Format with markdown.`;

    const response = await callOpenRouter(systemPrompt, [{ role: 'user', content: prompt }]);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Usage stats
app.get('/api/usage', async (req, res) => {
  res.json({
    daily: { asks: 0, photos: 0 },
    plan: 'free',
  });
});

// Verify Pro
app.post('/api/verify-pro', async (req, res) => {
  try {
    const { receipt, platform } = req.body;
    // In production, verify with App Store / Google Play
    res.json({ verified: true, plan: 'pro' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`StudyBuddy AI Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!OPENROUTER_API_KEY}`);
  console.log(`Model: ${OPENROUTER_MODEL}`);
});
