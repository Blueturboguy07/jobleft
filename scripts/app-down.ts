// `pnpm app:down` PLACEHOLDER. There is nothing to stop yet, because `pnpm app:up` starts nothing.
//
// The server lane replaces this file. The contract it must meet is in docs/INTERFACES.md,
// section "Start the whole app". In short, when it is built, this script will read
// $JOBLEFT_HOME/run/server.json, check that the pid still belongs to a jobleft server
// (GET /api/v1/health with the stored token), send SIGTERM, wait up to 10 s, and remove the file.

console.log('jobleft app:down is a placeholder: no jobleft process was started, so nothing was stopped.');
