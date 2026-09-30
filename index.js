require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Gemini API configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'StudyBuddy AI Server is running' });
});

// Check if API key is configured
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apiKeyConfigured: !!GEMINI_API_KEY,
  });
});

// Call Gemini API
async function callGemini(prompt, systemPrompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server');
  }

  const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: systemPrompt + '\n\n' + prompt }],
      }],
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `API request failed with status ${response.status}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
}

// Call Gemini API with image (multimodal)
async function callGeminiWithImage(base64Image, mimeType, prompt, systemPrompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server');
  }

  const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: systemPrompt + '\n\n' + prompt },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Image,
            },
          },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `API request failed with status ${response.status}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
}

// Subject-specific system prompts
const SUBJECT_PROMPTS = {
  'Math': 'You are a Math tutor. Show equations, explain each step clearly, and always give the final answer. Use proper mathematical notation.',
  'Science': 'You are a Science tutor. Explain concepts accurately, use correct scientific terminology, and break down complex ideas into understandable parts.',
  'Chemistry': 'You are a Chemistry tutor. Help with atoms, elements, periodic table, chemical formulas, balancing equations, reactions, moles, molar mass, stoichiometry, acids and bases, solutions, bonding, and lab questions. Show calculations and chemical steps when needed.',
  'English': 'You are an English tutor. Help with grammar, writing, reading comprehension, and literature analysis. Provide clear examples and explanations.',
  'History': 'You are a History tutor. Explain historical events, important people, causes and effects, and timelines. Provide context and connections.',
  'Geography': 'You are a Geography tutor. Explain locations, physical and human geography, and help with maps and spatial understanding.',
  'Computer Science': 'You are a Computer Science tutor. Explain programming concepts, algorithms, and help with debugging. Use code examples when helpful.',
  'Languages': 'You are a Languages tutor. Help with vocabulary, grammar, conversation practice, and cultural context.',
  'Engineering': 'You are an Engineering tutor. Explain engineering concepts, calculations, and design principles. Show formulas and units.',
  'Art': 'You are an Art tutor. Explain techniques, art history, and help with analysis and appreciation of artworks.',
  'Music': 'You are a Music tutor. Explain music theory, notation, history, and help with composition and analysis.',
  'Economics': 'You are an Economics tutor. Explain economic concepts, models, and analysis. Use graphs and real-world examples.',
  'Psychology': 'You are a Psychology tutor. Explain psychological concepts, theories, and research findings. Use examples to illustrate.',
  'Other': 'You are a general academic tutor. Provide helpful, accurate information across various subjects.',
  'All Subjects': '',
};

// Build system prompt based on education level and subject
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
  ? '- Use very simple words a 6-10 year old would understand\n- Use fun examples from everyday life\n- Keep explanations short and simple\n- Use emojis to make it fun'
  : level === 'middle'
    ? '- Use clear language a 11-13 year old would understand\n- Use relatable examples\n- Show step-by-step reasoning\n- Define any technical terms'
    : '- Use appropriate language for high school students (14-18)\n- Show detailed reasoning\n- Include relevant formulas or concepts when applicable\n- Explain the "why" behind concepts'}

Format your responses with markdown-style formatting:
- Use **bold** for important terms
- Use bullet points for lists
- Use numbered steps for processes
- Use line breaks to separate ideas`;

  // Add subject-specific prompt if provided
  if (subject && subject !== 'All Subjects' && SUBJECT_PROMPTS[subject]) {
    return `${basePrompt}\n\nSubject-specific instructions:\n${SUBJECT_PROMPTS[subject]}`;
  }

  return basePrompt;
}

// Ask AI endpoint
app.post('/api/ask', async (req, res) => {
  try {
    const { question, level = 'middle', subject = null, conversationHistory = [] } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
    const result = await callGemini(question, buildSystemPrompt(level, subject));
    res.json({ response: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate flashcards endpoint
app.post('/api/flashcards', async (req, res) => {
  try {
    const { topic, level = 'middle', subject = null } = req.body;
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    const prompt = `Create 5 study flashcards about "${topic}". Each flashcard should have a question (front) and an answer (back).

IMPORTANT: Respond with ONLY valid JSON in this exact format, no other text:
{
  "flashcards": [
    { "front": "Question text?", "back": "Answer text." }
  ]
}

Make sure:
- Questions are clear and specific
- Answers are concise but complete
- The flashcards cover the most important aspects of the topic
- Content is appropriate for a ${level === 'elementary' ? '6-10' : level === 'middle' ? '11-13' : '14-18'} year old student`;

    const response = await callGemini(prompt, buildSystemPrompt(level, subject));
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to generate flashcards' });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ flashcards: parsed.flashcards });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate quiz endpoint
app.post('/api/quiz', async (req, res) => {
  try {
    const { topic, level = 'middle', subject = null } = req.body;
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

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
- correctIndex is 0-based (0 = first option)
- Explanations are brief and helpful
- Content is appropriate for a ${level === 'elementary' ? '6-10' : level === 'middle' ? '11-13' : '14-18'} year old student`;

    const response = await callGemini(prompt, buildSystemPrompt(level, subject));
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to generate quiz' });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ questions: parsed.questions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Explain topic endpoint
app.post('/api/explain', async (req, res) => {
  try {
    const { topic, level = 'middle', subject = null } = req.body;
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }
    const result = await callGemini(
      `Explain the topic "${topic}" in detail. Start with a simple definition, then break it down into key concepts.`,
      buildSystemPrompt(level, subject)
    );
    res.json({ response: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Summarize notes endpoint
app.post('/api/summarize', async (req, res) => {
  try {
    const { notes, level = 'middle', subject = null } = req.body;
    if (!notes) {
      return res.status(400).json({ error: 'Notes are required' });
    }
    const result = await callGemini(
      `Summarize the following study notes. Keep the most important points and organize them clearly:\n\n${notes}`,
      buildSystemPrompt(level, subject)
    );
    res.json({ response: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Solve photo endpoint (multimodal)
app.post('/api/solve-photo', async (req, res) => {
  try {
    const { image, mimeType = 'image/jpeg', level = 'middle', subject = null, question = null } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'Image data is required' });
    }

    // Validate that the image data is base64
    if (typeof image !== 'string' || image.length === 0) {
      return res.status(400).json({ error: 'Invalid image data' });
    }

    let photoPrompt = `Look at this homework question in the image and help the student solve it.

Please:
1. **Identify the question** - Read and transcribe the question from the image
2. **Explain how to solve it step by step** - Show all work clearly
3. **Give the final answer** - Clearly state the answer

Guidelines:
- For math problems: Show the equation, explain each step, and give the final answer
- For science questions: Explain the concept, give examples, and provide the answer
- For English questions: Explain the passage or question clearly, then help answer it
- If the image is blurry or unreadable, say "The image appears to be blurry. Please take a clearer photo."
- If no question is detected, say "I couldn't find a homework question in this image. Please try again with a clearer photo."
- Be encouraging and supportive!`;

    if (question) {
      photoPrompt += `\n\nAdditional context from student: ${question}`;
    }

    const result = await callGeminiWithImage(image, mimeType, photoPrompt, buildSystemPrompt(level, subject));
    res.json({ response: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat endpoint with conversation history
app.post('/api/chat', async (req, res) => {
  try {
    const { subject = null, question, conversationHistory = [], level = 'middle' } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const historyText = conversationHistory
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n');

    const prompt = historyText
      ? `Previous conversation:\n${historyText}\n\nNew question: ${question}`
      : question;

    const result = await callGemini(prompt, buildSystemPrompt(level, subject));
    res.json({ response: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Quick action endpoint
app.post('/api/quick-action', async (req, res) => {
  try {
    const { action, conversationHistory = [], subject = null, level = 'middle' } = req.body;
    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    const QUICK_ACTION_PROMPTS = {
      simpler: 'Can you explain that in simpler terms? Use easier words and smaller steps.',
      steps: 'Can you show me the steps to solve this?',
      example: 'Can you give me an example to help me understand?',
      quiz: 'Can you give me a quiz on this topic? Ask me questions one at a time.',
      practice: 'Can you give me practice problems to work on?',
      confused: "I'm still confused. Can you explain that differently? Use a different approach or analogy.",
    };

    const actionPrompt = QUICK_ACTION_PROMPTS[action];
    if (!actionPrompt) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const historyText = conversationHistory
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n');

    const prompt = historyText
      ? `Previous conversation:\n${historyText}\n\nFollow-up request: ${actionPrompt}`
      : actionPrompt;

    const result = await callGemini(prompt, buildSystemPrompt(level, subject));
    res.json({ response: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Practice problems endpoint
app.post('/api/practice-problems', async (req, res) => {
  try {
    const { subject = null, level = 'middle' } = req.body;

    const subjectContext = subject ? ` Create problems specifically about ${subject}.` : '';
    const prompt = `Create 5 practice problems for a student to solve.${subjectContext}

IMPORTANT: Respond with ONLY valid JSON in this exact format, no other text:
{
  "problems": [
    {
      "question": "Problem statement that requires a written answer (not multiple choice)",
      "hint": "A helpful hint to guide the student (optional)"
    }
  ]
}

Make sure:
- Problems require written answers (not multiple choice)
- Problems test understanding and application of concepts
- Each problem is clear and unambiguous
- Hints are helpful but don't give away the answer
- Content is appropriate for a ${level === 'elementary' ? '6-10' : level === 'middle' ? '11-13' : '14-18'} year old student`;

    const response = await callGemini(prompt, buildSystemPrompt(level, subject));
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to generate practice problems' });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ problems: parsed.problems });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check answer endpoint
app.post('/api/check-answer', async (req, res) => {
  try {
    const { question, answer, subject = null, level = 'middle' } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: 'Question and answer are required' });
    }

    const subjectContext = subject ? ` This is a ${subject} problem.` : '';
    const prompt = `You are checking a student's answer to a practice problem.${subjectContext}

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
- Provide a clear, concise correct answer
- Explain the reasoning behind the correct answer`;

    const response = await callGemini(prompt, buildSystemPrompt(level, subject));
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to check answer' });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({
      isCorrect: parsed.isCorrect,
      explanation: parsed.explanation,
      correctAnswer: parsed.correctAnswer,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Study plan endpoint
app.post('/api/study-plan', async (req, res) => {
  try {
    const { subject = null, topic, date, availableTime, level = 'middle' } = req.body;
    if (!topic || !date || !availableTime) {
      return res.status(400).json({ error: 'Topic, date, and availableTime are required' });
    }

    const subjectContext = subject ? ` This is a ${subject} study plan.` : '';
    const prompt = `Create a personalized study plan for the following:

Topic: ${topic}
Date: ${date}
Available time: ${availableTime}
Education level: ${level}${subjectContext}

Create a detailed study plan that includes:
1. A clear goal for the study session
2. Break the topic into subtopics or chunks
3. Allocate time for each subtopic
4. Include active recall and practice activities
5. Add short breaks
6. End with a quick review or self-test

Format the response in a clear, organized way with markdown formatting.`;

    const result = await callGemini(prompt, buildSystemPrompt(level, subject));
    res.json({ response: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Usage stats endpoint
app.get('/api/usage', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    // In a real app, this would query a database
    // For now, return mock daily usage stats
    res.json({
      date: today,
      totalQuestions: 0,
      totalChats: 0,
      totalFlashcards: 0,
      totalQuizzes: 0,
      totalPracticeProblems: 0,
      dailyLimit: 50,
      remaining: 50,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify Pro endpoint
app.post('/api/verify-pro', async (req, res) => {
  try {
    const { receipt, platform } = req.body;
    if (!receipt) {
      return res.status(400).json({ error: 'Receipt is required' });
    }

    // In a real app, this would verify the receipt with Apple/Google
    // For now, return a mock verification response
    res.json({
      isValid: true,
      plan: 'pro',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      message: 'Pro subscription verified successfully',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`StudyBuddy AI Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!GEMINI_API_KEY}`);
});
