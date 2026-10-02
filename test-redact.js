/**
 * Tests the log redaction.
 *
 * This exists because the leak it prevents was real: provider error bodies were
 * logged verbatim, and Google's Generative Language API echoes the rejected key
 * back inside its error message. An expired or mistyped key was therefore written
 * to the server log in full, where anyone with dashboard access could read it
 * and where it survived the rotation that fixed the problem.
 *
 * The cases below use the actual error shapes these providers return, not
 * invented ones, because a redaction test against the wrong string proves
 * nothing.
 *
 * The sample keys are assembled from fragments on purpose. Written out whole they
 * are indistinguishable from live credentials, so they trip GitHub's secret
 * scanning, cloud provider secret scanners, and eventually a human reviewing a
 * diff. Assembling them here keeps the test exact while leaving nothing in the
 * repository that looks like a real key.
 *
 * Run with: node test-redact.js
 */
const { redactSecrets } = require('./redact');

/** Joins parts at runtime, so no complete credential is ever stored in this file. */
const join = (...parts) => parts.join('');

// Google. Shaped like a real Gemini key so the pattern has something true to
// match, but assembled so it is not a literal in the repository.
const GOOGLE_KEY = join('AIzaSy', 'D1x2y3z4w5v', '6u7t8s9r0q1p', '2o3n4');
// OpenAI-style.
const SK_KEY = join('sk-proj-', 'AbCdEf0123', '456789XyZ');
// Groq-style.
const GROQ_KEY = join('gsk-', '0123456789', 'abcdefghijkl');
// GitHub-style.
const GH_KEY = join('ghp_', 'AbCdEfGhIjKl', 'MnOpQrStUvWx', 'Yz0123');
// AWS-style. The suffix is the one from AWS's own documentation, so it is not a
// real account.
const AWS_KEY = join('AKIA', 'IOSFODNN7', 'EXAMPLE');
// OpenRouter-style, used as a "key this process actually holds".
const HELD_KEY = join('sk-or-v1-', 'aaaaaaaaaaaaaaa', 'abbbbbbbbbbbbbbbb');

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        got      ${JSON.stringify(actual)}`);
  }
}

// Sanity: the fragments really do assemble into what the patterns expect,
// otherwise the tests below would pass for the wrong reason.
check('the sample keys assemble correctly', GOOGLE_KEY.startsWith('AIzaSy'), true);
check('the sample keys are long enough to match', GOOGLE_KEY.length > 30, true);

// The exact shape Google returns for a rejected key. This is the leak.
check(
  'a rejected Google key is removed from the message',
  redactSecrets(
    `{"error":{"code":400,"message":"API key not valid: ${GOOGLE_KEY}","status":"INVALID_ARGUMENT"}}`,
  ),
  '{"error":{"code":400,"message":"API key not valid: [redacted-key]","status":"INVALID_ARGUMENT"}}',
);

// A key using the underscore and hyphen characters.
check(
  'a Google key with hyphens is removed',
  redactSecrets(`key ${join('AIzaSy-B_c_d-', '0123456789abcdef')} rejected`),
  'key [redacted-key] rejected',
);

check(
  'an sk- key is removed',
  redactSecrets(`Incorrect API key provided: ${SK_KEY}`),
  'Incorrect API key provided: [redacted-key]',
);
check(
  'a gsk- key is removed',
  redactSecrets(`error: invalid x-api-key ${GROQ_KEY}`),
  'error: invalid x-api-key [redacted-key]',
);

// The header form, which is how a key usually shows up in a provider dump.
check(
  'a bearer token is removed but the header name is kept',
  redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'),
  'Authorization: Bearer [redacted-key]',
);

check(
  'a github token is removed',
  redactSecrets(`bad credentials ${GH_KEY}`),
  'bad credentials [redacted-key]',
);
check(
  'an AWS access key id is removed',
  redactSecrets(`The AWS key ${AWS_KEY} is not valid`),
  'The AWS key [redacted-key] is not valid',
);

// The real defence: a key this process actually holds, in whatever format.
process.env.OPENROUTER_API_KEY = HELD_KEY;
process.env.GEMINI_API_KEY = GOOGLE_KEY;
check(
  'a key held by this process is removed even in an unknown format',
  redactSecrets(`upstream said: ${HELD_KEY} is unknown`),
  'upstream said: [redacted-key] is unknown',
);
check('the second held key is removed too', redactSecrets(`${GOOGLE_KEY} invalid`), '[redacted-key] invalid');
delete process.env.OPENROUTER_API_KEY;
delete process.env.GEMINI_API_KEY;

// A long opaque token with no recognisable prefix.
check(
  'an unrecognised long token is still removed',
  redactSecrets('token QWxhZGRpbjpvcGVuc2VzYW1l1234567890QWERTYUIOP12345 failed'),
  'token [redacted-long-token] failed',
);

// What must survive. Redaction that eats the diagnostic is no better than none.
check(
  'the provider name and status are kept',
  redactSecrets('[upstream] openrouter/nvidia-nemotron -> 401 {"message":"unauthorized"}'),
  '[upstream] openrouter/nvidia-nemotron -> 401 {"message":"unauthorized"}',
);
check(
  'an ordinary short error message is untouched',
  redactSecrets('rate limit exceeded for model gpt-4'),
  'rate limit exceeded for model gpt-4',
);
check('an empty string is safe', redactSecrets(''), '');
check('undefined is safe', redactSecrets(undefined), '');
check('null is safe', redactSecrets(null), '');

// The log line must never contain the key, whatever the provider wrapped it in.
const leak = redactSecrets(
  `provider said: {"key":"${GOOGLE_KEY}","reason":"PERMISSION_DENIED"}`,
);
check('the key cannot be recovered from the redacted line', leak.includes('AIzaSy'), false);

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\n!! redaction is not holding:');
  for (const f of failures) console.error('   - ' + f);
  process.exit(1);
}
console.log('  provider keys can no longer reach the log');