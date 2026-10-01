/**
 * The learning endpoints behind Teach Me, Hint and Practice Me.
 *
 * Split out of index.js because the prompts decide what a student is actually
 * taught, and burying them in a file that also does routing, provider selection
 * and vision makes them impossible to review.
 *
 * Notes:
 * - Every prompt goes through buildSystemPrompt, so subject, school level,
 *   answer style and language behave exactly as they do everywhere else. Nothing
 *   here quietly uses different rules from the rest of the app.
 * - Practice and check return JSON because the app has to compare an answer.
 *   Extraction matches the existing endpoints rather than adding a second way of
 *   doing it.
 * - Nothing fabricates a result. If the model returns something unusable the
 *   request fails and the student is offered a retry, which is what the app does.
 */

const SUBJECT_FLAVOUR = {
  Math: 'a maths problem',
  Science: 'a science question',
  Chemistry: 'a chemistry question',
  English: 'a reading or writing task',
  History: 'a history question',
  Geography: 'a geography question',
  'Computer Science': 'a programming or computer science question',
  Languages: 'a language question',
  Engineering: 'an engineering problem',
  Art: 'an art or design question',
  Music: 'a music question',
  Economics: 'an economics question',
  Psychology: 'a psychology question',
  Other: 'a question',
};

/** Strips model preamble and caps length, so nothing odd reaches the app. */
function safe(value, max = 1500) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

/**
 * Pulls the first JSON object out of a model reply.
 *
 * Matches what the existing quiz and practice endpoints do. Returns null rather
 * than throwing so each route can report a friendly failure of its own.
 */
function extractJson(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Registers every learning route on the app.
 *
 * Dependencies are injected rather than imported so this file stays independent
 * of how index.js happens to be structured.
 */
function registerLearningRoutes(app, deps) {
  const {
    buildSystemPrompt,
    callTextModel,
    streamText,
    setupSSE,
    streamError,
    readLanguage,
    friendlyProviderError,
  } = deps;

  const subjectNote = (subject, question) => {
    if (subject && subject !== 'All Subjects') {
      return `The student is studying ${subject}.`;
    }
    const flavour = SUBJECT_FLAVOUR.Math;
    void flavour;
    return (
      'The student did not choose a subject, so decide from the question itself and ' +
      'teach it as ' +
      `${SUBJECT_FLAVOUR[subject] ?? SUBJECT_FLAVOUR.Other}. ` +
      `The question was: ${safe(question, 300)}`
    );
  };

  // ---------------------------------------------------------------- Teach Me
  // Streamed because this is the longest thing the app asks for and a student
  // waiting on a spinner for a full explanation is a poor experience.
  app.post('/api/learn/teach/stream', async (req, res) => {
    const {
      question,
      answer = '',
      subject = null,
      schoolLevel,
      answerStyle,
      fromPhoto = false,
    } = req.body ?? {};
    if (!question) return res.status(400).json({ error: 'A question is required.' });

    try {
      const system = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
      const prompt = [
        system,
        '',
        subjectNote(subject, question),
        '',
        fromPhoto
          ? [
              'The student photographed their homework and has already been given this answer:',
              safe(answer, 1200),
              '',
              'Work out from that answer which problem was being asked, then teach that problem.',
              'Open your explanation by restating the problem in one line under "What we are solving".',
              'Do not invent extra parts of the problem that the answer does not show.',
            ].join('\n')
          : [
              'The student already has this problem and its answer:',
              `Problem: ${safe(question, 600)}`,
              answer ? `Answer they were given: ${safe(answer, 800)}` : '',
            ].join('\n'),
        question && !fromPhoto ? safe(question, 400) : '',
        '',
        'Teach it. Do not simply repeat the answer you already gave them.',
        'Use exactly these headings, in this order:',
        '',
        '**What we are solving**',
        'One or two sentences saying what the question actually asks.',
        '',
        '**The key idea**',
        'The rule, formula or idea this depends on, in one or two sentences.',
        '',
        '**Step 1**',
        'What to do, then why it works. Put any maths on its own line.',
        'Repeat for each further step that is needed. Use only as many steps as the problem takes.',
        '',
        '**Why this works**',
        'One sentence confirming the answer satisfies the original question.',
        '',
        'Rules:',
        '- Simple everyday words, the kind a student would say out loud.',
        '- If you must use a technical term, explain it in the same sentence.',
        '- Every step says what to do AND why, never the what on its own.',
        '- Put all maths inside $...$ so it renders as real mathematics.',
        '- No greeting, no praise, no filler. Start with the first heading.',
        '- Do not add background the student did not ask for.',
      ]
        .filter(Boolean)
        .join('\n');

      setupSSE(res);
      await streamText(prompt, [{ role: 'user', content: 'Teach me this problem.' }], res);
    } catch (err) {
      console.error('[learn/teach]', err?.message);
      streamError(res, friendlyProviderError(err), errorReasonLike(err));
    }
  });

  // ------------------------------------------------------------------- Hint
  // Non-streaming: a hint is deliberately short, so streaming would add latency
  // for no benefit.
  app.post('/api/learn/hint', async (req, res) => {
    const {
      question,
      subject = null,
      schoolLevel,
      answerStyle,
      hints = [],
      stepIndex = 0,
    } = req.body ?? {};
    if (!question) return res.status(400).json({ error: 'A question is required.' });

    try {
      const previous = (Array.isArray(hints) ? hints : [])
        .map((h, i) => `${i + 1}. ${safe(h, 300)}`)
        .join('\n');

      const system = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
      const prompt = [
        system,
        '',
        subjectNote(subject, question),
        '',
        `The student is stuck on: ${safe(question, 600)}`,
        previous ? `\nHints they have already been given:\n${previous}` : '',
        '',
        `Give hint number ${(Array.isArray(hints) ? hints.length : 0) + 1}. They are at step ${Number(stepIndex) || 0} of the solution.`,
        '',
        'Rules:',
        '- Move them forward WITHOUT giving the answer away.',
        '- Ask them a question, or point at the operation they need.',
        '- Never state the final answer, and never write the next line of the solution for them.',
        '- One or two sentences at most.',
        '- Put any maths inside $...$.',
      ]
        .filter(Boolean)
        .join('\n');

      const text = await callTextModel(prompt, [{ role: 'user', content: 'Give me a hint.' }], 300);
      res.json({ hint: safe(text, 400) });
    } catch (err) {
      console.error('[learn/hint]', err?.message);
      res.status(500).json({ error: 'Could not fetch a hint right now. Please try again.' });
    }
  });

  // ------------------------------------------------------------- Practice Me
  app.post('/api/learn/practice', async (req, res) => {
    const {
      question,
      subject = null,
      schoolLevel,
      answerStyle,
      difficulty = 'similar',
      index = 0,
    } = req.body ?? {};
    if (!question) return res.status(400).json({ error: 'A question is required.' });

    try {
      const system = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
      const prompt = [
        system,
        '',
        subjectNote(subject, question),
        '',
        `Here is the problem the student has just learned: ${safe(question, 600)}`,
        '',
        `Write ONE new problem that is ${safe(difficulty, 40)} to it.`,
        '',
        'Rules:',
        '- Exactly the same kind of problem at the same level of difficulty.',
        '- Different numbers or wording from the original.',
        '- The answer must be short and unambiguous: a number, a word, or a short phrase.',
        '- Make sure the problem is solvable and the answer is actually correct.',
        '- Give a one-sentence hint that helps without giving the answer away.',
        '',
        'Reply with ONLY valid JSON, no other text:',
        '{"question":"...","answer":"...","hint":"..."}',
      ].join('\n');

      const text = await callTextModel(prompt, [{ role: 'user', content: 'Give me a practice problem.' }], 500);
      const data = extractJson(text);
      if (!data || !data.question || data.answer === undefined || data.answer === null) {
        throw new Error('parse');
      }
      res.json({
        question: safe(data.question, 600),
        // The answer is kept as a string because "2/4" and "0.5" both arrive as
        // text and the app normalises them when comparing.
        answer: safe(data.answer, 120),
        hint: safe(data.hint, 300),
        index: Number(index) || 0,
      });
    } catch (err) {
      console.error('[learn/practice]', err?.message);
      res
        .status(500)
        .json({ error: 'Could not make a practice question right now. Please try again.' });
    }
  });

  // ------------------------------------------------------------------ Check
  app.post('/api/learn/check', async (req, res) => {
    const {
      question,
      correctAnswer,
      studentAnswer,
      subject = null,
      schoolLevel,
      answerStyle,
    } = req.body ?? {};
    if (!question || correctAnswer === undefined) {
      return res.status(400).json({ error: 'A question and answer are required.' });
    }

    try {
      const system = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
      const prompt = [
        system,
        '',
        `Practice problem: ${safe(question, 600)}`,
        `Correct answer: ${safe(correctAnswer, 200)}`,
        `The student answered: ${safe(studentAnswer, 200)}`,
        '',
        'Decide whether the student is right. Accept equivalent forms, so 2/4 and 0.5 ' +
          'are both correct, and x = 5 and 5 are both correct.',
        '',
        'Rules:',
        '- Never be discouraging, and never imply the student is stupid.',
        '- explanation: one or two sentences saying why the answer is right or what to reconsider.',
        '- hint: only when correct is false. Point at the right step without giving the answer away.',
        '- Put any maths inside $...$.',
        '',
        'Reply with ONLY valid JSON, no other text:',
        '{"correct":true,"explanation":"...","hint":"..."}',
      ].join('\n');

      const text = await callTextModel(
        prompt,
        [{ role: 'user', content: 'Check my answer.' }],
        400,
      );
      const data = extractJson(text);
      if (!data || typeof data.correct !== 'boolean') throw new Error('parse');
      res.json({
        correct: data.correct,
        explanation: safe(data.explanation, 500),
        hint: data.correct ? '' : safe(data.hint, 300),
      });
    } catch (err) {
      console.error('[learn/check]', err?.message);
      res.status(500).json({ error: 'Could not check that answer right now. Please try again.' });
    }
  });

  // -------------------------------------------------------------- Follow-up
  app.post('/api/learn/followup/stream', async (req, res) => {
    const {
      question,
      answer = '',
      teaching = '',
      subject = null,
      schoolLevel,
      answerStyle,
      followUp,
      history = [],
    } = req.body ?? {};
    if (!question || !followUp) {
      return res.status(400).json({ error: 'A question and a follow-up are required.' });
    }

    try {
      const system = buildSystemPrompt(schoolLevel, subject, answerStyle, readLanguage(req.body));
      const prompt = [
        system,
        '',
        subjectNote(subject, question),
        '',
        `The original problem: ${safe(question, 600)}`,
        answer ? `The answer given: ${safe(answer, 500)}` : '',
        teaching ? `What they were taught:\n${safe(teaching, 2500)}` : '',
        '',
        `The student now asks: ${safe(followUp, 400)}`,
        '',
        'Answer that question directly and briefly. Keep every maths expression inside $...$ ' +
          'so it renders as real mathematics. No greeting and no filler.',
      ]
        .filter(Boolean)
        .join('\n');

      // Earlier turns of the session, so "why?" and "explain step 2" have context.
      const prior = (Array.isArray(history) ? history : [])
        .slice(-6)
        .map((m) => ({
          role: m?.role === 'assistant' ? 'assistant' : 'user',
          content: safe(m?.content, 600),
        }))
        .filter((m) => m.content);

      setupSSE(res);
      await streamText(prompt, [...prior, { role: 'user', content: safe(followUp, 400) }], res);
    } catch (err) {
      console.error('[learn/followup]', err?.message);
      streamError(res, friendlyProviderError(err), 'upstream');
    }
  });
}

/** Small local copy so this file does not need index.js's error helper. */
function errorReasonLike(err) {
  const code = Number(err?.status ?? err?.code);
  if (Number.isFinite(code) && code >= 400 && code < 600) return 'upstream';
  return 'network';
}

module.exports = { registerLearningRoutes, extractJson, safe, SUBJECT_FLAVOUR };