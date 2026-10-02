/**
 * Removes credentials from text that is about to be written to the log.
 *
 * Why this exists: when an AI provider refuses a request, its error body used to
 * be logged verbatim. Providers routinely echo the credential back inside that
 * body. Google's Generative Language API, for example, answers a bad key with:
 *
 *   {"error":{"message":"API key not valid: AIzaSyD-1a2b3c4d5e6f",
 *             "status":"INVALID_ARGUMENT"}}
 *
 * So an expired or mistyped key wrote that key into the server log in full, where
 * anyone with dashboard access could read it and where it outlived the rotation
 * that fixed the problem. Any authenticated failure was enough to trigger it.
 *
 * Kept as its own module, with no Express or network code, so it can be tested
 * directly. It is a pure function: same input, same output, nothing to mock.
 */

/**
 * The credentials this process holds, gathered so they can be matched literally.
 *
 * Matching the real value is the most reliable part of this: a provider that
 * invents an unfamiliar key format is still caught, because the literal is
 * matched even if every pattern below missed it.
 */
function secretsHeldByThisProcess() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GROQ_API_KEY,
    process.env.OPENROUTER_API_KEY,
  ].filter((k) => typeof k === 'string' && k.length >= 8);
}

/**
 * Redacts anything shaped like a credential.
 *
 * Covers the shapes the providers actually return rather than trying to be
 * clever. The final catch-all trades a little false-positive rate on long
 * identifiers for certainty, which is the right way round for a log.
 */
function redactSecrets(input) {
  let out = String(input ?? '');

  for (const secret of secretsHeldByThisProcess()) {
    out = out.split(secret).join('[redacted-key]');
  }

  return (
    out
      // Google style: "API key not valid: AIzaSy...".
      .replace(/\b(AIza[0-9A-Za-z_-]{10,})/g, '[redacted-key]')
      // OpenAI, Groq, xAI and generic provider prefixes.
      .replace(/\b(sk|pk|rk|gsk|xai)-[0-9A-Za-z_-]{12,}/g, '[redacted-key]')
      // GitHub style, in case a key is ever pasted into a support question.
      .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[0-9A-Za-z_]{16,}/g, '[redacted-key]')
      // "Authorization: Bearer <token>" and bare bearer tokens.
      .replace(/(Bearer\s+)[0-9A-Za-z_.-]{12,}/gi, '$1[redacted-key]')
      // AWS style.
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]')
      // Anything else that is one long unbroken token. Catches shapes not
      // listed above.
      .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted-long-token]')
  );
}

module.exports = { redactSecrets, secretsHeldByThisProcess };