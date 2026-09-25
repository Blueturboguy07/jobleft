// `pnpm app:up` PLACEHOLDER. Nothing is started yet.
//
// The server lane replaces this file. The contract it must meet is in docs/INTERFACES.md,
// section "Start the whole app". In short, when it is built, this script will:
//   1. resolve JOBLEFT_HOME (default for development: <repo>/.jobleft-dev),
//   2. start apps/server on 127.0.0.1 with a fresh launch token,
//   3. wait for GET /api/v1/health, write $JOBLEFT_HOME/run/server.json (mode 0600),
//   4. print the UI address (the token goes in the URL fragment, never in a query string).
//
// It exits with code 1 so that no script or person mistakes the placeholder for a running app.

console.error(
  'jobleft app:up is a placeholder: nothing was started.\n' +
    'The server lane builds it. See docs/INTERFACES.md, section "Start the whole app".',
);
process.exitCode = 1;
