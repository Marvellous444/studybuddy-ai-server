/**
 * Boots the server locally and checks that a failure cannot leak anything.
 *
 * Two things are being verified:
 *
 * 1. The 404 handler. Without it Express answers an unknown path with its own
 *    HTML page, which confirms the framework and gives the app a body it cannot
 *    parse as JSON.
 *
 * 2. The error handler. Express's built-in one answers a malformed JSON body with
 *    the raw parser message, and in development returns a stack trace naming
 *    files, line numbers and internal function names. Neither may reach a client.
 *
 * Nothing here needs a real AI key: every route is reached with an empty body, so
 * each one stops at its own validation before calling a provider.
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['index.js'], {
  cwd: __dirname,
  // Deliberately fake keys. The server refuses to start without one, which is
  // correct, but every request below is sent with an empty or malformed body and
  // stops at the route's own validation, so no provider is ever contacted. Using
  // the real keys would put live credentials into a test file for no benefit.
  env: {
    ...process.env,
    PORT: String(PORT),
    OPENROUTER_API_KEY: 'sk-or-v1-test0000000000000000000000test',
    OPENROUTER_MODEL: 'test/no-op',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => {
  serverLog += d.toString();
});
server.stderr.on('data', (d) => {
  serverLog += d.toString();
});

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
    console.log(`        got      ${JSON.stringify(String(actual).slice(0, 200))}`);
  }
}

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  try {
    if (!(await waitForServer())) {
      console.error('  the server did not start. log:');
      console.error(serverLog.slice(0, 600));
      process.exit(1);
    }

    // 1. An unknown path must be JSON, not Express's HTML page.
    const missing = await fetch(`${BASE}/api/does-not-exist`);
    const missingBody = await missing.text();
    check('an unknown path returns 404', missing.status, 404);
    check('an unknown path returns JSON', missing.headers.get('content-type') || '', 'application/json; charset=utf-8');
    check('an unknown path leaks no HTML', missingBody.includes('<'), false);
    check('an unknown path is parsed JSON', (() => {
      try {
        JSON.parse(missingBody);
        return true;
      } catch {
        return false;
      }
    })(), true);

    // 2. A malformed body must not echo the parser message or a stack.
    const bad = await fetch(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"question": "unterminated',
    });
    const badBody = await bad.text();
    check('a malformed body returns 400', bad.status, 400);
    check('a malformed body returns JSON', bad.headers.get('content-type') || '', 'application/json; charset=utf-8');
    // A real stack frame looks like "at Module._compile" or "    at Object.<anonymous>",
    // not just "at " on its own. The looser check produced a false positive on the
    // word "That" inside the friendly message, which is the sort of mistake that
    // makes a test look like it caught something when it did not.
    check(
      'a malformed body leaks no stack frame',
      /\bat\s+(?:Module|Object|Function|AsyncFunction|internal|node:)/.test(badBody),
      false,
    );
    check('a malformed body contains no newline run', /\n\s*\n/.test(badBody), false);
    check('a malformed body leaks no file path', badBody.includes('index.js'), false);
    check('a malformed body leaks no parser detail', badBody.toLowerCase().includes('unexpected'), false);

    // 3. A valid route still validates normally.
    const ok = await fetch(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '' }),
    });
    check('an empty question is still rejected', ok.status, 400);

    // 4. The health endpoint must still work, because deploys depend on it.
    const health = await fetch(`${BASE}/api/health`);
    const healthBody = await health.text();
    check('health still responds', health.status, 200);
    check('health leaks no key', /AIza|sk-|Bearer\s+[A-Za-z0-9]/.test(healthBody), false);

    // 5. No key may appear anywhere in what the server wrote while handling these.
    const keys = [
      process.env.GEMINI_API_KEY,
      process.env.GROQ_API_KEY,
      process.env.OPENROUTER_API_KEY,
    ].filter((k) => typeof k === 'string' && k.length >= 8);
    check(
      'no held key reached the server log',
      keys.some((k) => serverLog.includes(k)),
      false,
    );
  } finally {
    server.kill();
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\n!! a failure path leaks something:');
    for (const f of failures) console.error('   - ' + f);
    process.exit(1);
  }
  console.log('  failure responses carry no internal detail');
})();

process.on('exit', () => server.kill());