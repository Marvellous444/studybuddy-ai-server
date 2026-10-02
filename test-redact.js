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
 * Run with: node test-redact.js
 */
const { redactSecrets } = require('./redact');

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

// The exact shape Google returns for a rejected key. This is the leak.
check(
  'a rejected Google key is removed from the message',
  redactSecrets(
    '{"error":{"code":400,"message":"API key not valid: AIzaSyD1x2y3z4w5v6u7t8s9r0q1p2o3n4","status":"INVALID_ARGUMENT"}}',
  ),
  '{"error":{"code":400,"message":"API key not valid: [redacted-key]","status":"INVALID_ARGUMENT"}}',
);

// The same, with a key that uses the underscore and hyphen characters.
check(
  'a Google key with hyphens is removed',
  redactSecrets('key AIzaSy-B_c_d-0123456789abcdef rejected'),
  'key [redacted-key] rejected',
);

// OpenAI and Groq style prefixes.
check(
  'an sk- key is removed',
  redactSecrets('Incorrect API key provided: sk-proj-AbCdEf0123456789XyZ'),
  'Incorrect API key provided: [redacted-key]',
);
check(
  'a gsk- key is removed',
  redactSecrets('error: invalid x-api-key gsk-0123456789abcdefghijkl'),
  'error: invalid x-api-key [redacted-key]',
);

// The header form, which is how a key usually shows up in a provider dump.
check(
  'a bearer token is removed but the header name is kept',
  redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'),
  'Authorization: Bearer [redacted-key]',
);

// GitHub and AWS shapes, in case a key is ever pasted into a support question.
check(
  'a github token is removed',
  redactSecrets('bad credentials ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123'),
  'bad credentials [redacted-key]',
);
check(
  'an AWS access key id is removed',
  redactSecrets('The AWS key AKIAIOSFODNN7EXAMPLE is not valid'),
  'The AWS key [redacted-key] is not valid',
);

// The real defence: a key this process actually holds, in whatever format.
process.env.OPENROUTER_API_KEY = 'sk-or-v1-aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbb';
process.env.GEMINI_API_KEY = 'AIzaSyTotallyMadeUpKeyForTestingOnly12345';
check(
  'a key held by this process is removed even in an unknown format',
  redactSecrets('upstream said: sk-or-v1-aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbb is unknown'),
  'upstream said: [redacted-key] is unknown',
);
check(
  'the second held key is removed too',
  redactSecrets('AIzaSyTotallyMadeUpKeyForTestingOnly12345 invalid'),
  '[redacted-key] invalid',
);
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
  'provider said: {"key":"AIzaSyD1x2y3z4w5v6u7t8s9r0q1p2o3n4","reason":"PERMISSION_DENIED"}',
);
check('the key cannot be recovered from the redacted line', leak.includes('AIzaSy'), false);

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\n!! redaction is not holding:');
  for (const f of failures) console.error('   - ' + f);
  process.exit(1);
}
console.log('  provider keys can no longer reach the log');