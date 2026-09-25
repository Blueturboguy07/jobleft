# @jobleft/contracts

Shared types, JSON Schemas and small runtime validators for every jobleft package, the local API and the extension protocol.

Status: skeleton (foundation commit). The public interface, CLI names, data files and environment
variables are specified in [docs/INTERFACES.md](../../docs/INTERFACES.md), section `@jobleft/contracts`.
Implement that interface here and keep this README in step with it.

## Commands

| Command | What it does |
|---|---|
| `pnpm --filter @jobleft/contracts test` | Run the tests (`node --test "test/*.test.ts"`) |
| `pnpm --filter @jobleft/contracts typecheck` | Type-check (`tsc -p tsconfig.json`, no output files) |

## Rules

- ESM TypeScript that Node 24 runs directly: erasable syntax only (no enums, namespaces or parameter properties), relative imports end in `.ts`, type-only imports use `import type`.
- Types that cross a package boundary live in `@jobleft/contracts`. Contracts change by addition only.
- Third-party code: read it first, install with scripts off, copy only MIT, Apache-2.0 or BSD code, and record each copy in `THIRD_PARTY_NOTICES.md`.
- No personal data in any request, file or test. Tests use the fake persona "Jordan Testwell" (jordan.testwell@example.com).
