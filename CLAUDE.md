<!-- stack-template: claude-md/project-stub@2 94bd64717081 -->

# Cellar

Self-hosted, single-tenant YouTube archiver. **Read `docs/ARCHITECTURE.md` first** - it
is the locked spec for module boundaries, the data model, the API surface and the
security rules. The build brief that produced it is `.claude/cellar-spec.md`.
Deviating from either requires a note in the commit message and a matching doc update.

## Commands

```bash
npm install
npm run dev              # server (:8080) and web dev server (:5173)
npm test                 # vitest across shared, server, web
npm run test:coverage    # plus v8 coverage into coverage/
npm run coverage:ratchet # fail if coverage dropped more than 0.5 points
npm run lint             # eslint plus scripts/check-ascii.mjs
npm run format:check     # prettier
npm run typecheck        # tsc for shared/server/e2e, vue-tsc for web
npm run build            # shared -> server -> web
npm run test:e2e         # Playwright against the built server (insecure flag)
```

`shared` must be built before `server` and `web` can resolve its types.
`npm run build` and `npm run typecheck` already do that in order.

## Layout

- `shared/` - zod schemas, API types, rule AST + effects registry, settings
  registry, id parser, filename template renderer. Pure logic, no IO.
- `server/` - Fastify 5 API, node:sqlite data layer, job scheduler, yt-dlp and
  ffmpeg runners, the public `/s` share routes.
- `web/` - Vue 3 + Vite + PrimeVue 4 admin SPA (`index.html`) and the minimal
  public share bundle (`share.html`, served under `/s/`).
- `e2e/` - Playwright: UI flows against the built server plus a Docker image check.
- `deploy/` - the NAS Custom App compose file and runbook. `docs/` - specs, brand.
- `scripts/` - check-ascii, coverage ratchet, fake yt-dlp/ffmpeg shims for tests.

## Dependency pins

- **PrimeVue stays on 4.x, `@primeuix/themes` on 2.x.** PrimeVue 5 switched to the
  commercial PrimeUI license model; every deployment needs a key and shows an
  "Invalid PrimeUI License" banner without one. 4.x is MIT. Dependabot ignores
  both majors.
- **TypeScript stays on 6.x**, not 7.x - typescript-eslint's peer range caps it.
- **Node 26 only** (`engines >=26`, `.node-version`); no older-Node compat job.

## Commit messages

**Conventional Commits, always**: `type(scope): summary`. Types: `feat`, `fix`,
`refactor`, `test`, `docs`, `chore`, `build`, `ci`, `perf`. Summary lower case,
imperative, no trailing period. Body explains WHY, wrapped at 72 columns.

## Style rules

- **TypeScript, ESM only.** Relative imports carry a `.ts` extension
  (`rewriteRelativeImportExtensions` rewrites them on build).
- **pino only, never `console.*`** in `server/` or `shared/`. Child loggers per
  module: `log.child({ mod: "jobs" })`. ESLint enforces this.
- **No em dashes or en dashes anywhere.** Not in code, comments, docs, YAML,
  commit messages, or UI copy. Use an ASCII `-`. `npm run lint` fails on them.
- **Prettier**: semicolons, double quotes, 2-space indent, 100 columns.
- **LF line endings everywhere.** `.gitattributes` sets `* text=auto eol=lf`.
- Every migration is append-only. Never edit one that has already shipped.
- Credentials (cookies, refresh tokens, proxy URLs, Access JWTs) never enter
  argv, URLs, logs, API responses or error messages.
- yt-dlp and ffmpeg are spawned with argv arrays, never a shell.

## This repo is public

Never commit secrets. `.env` files are gitignored; `.env.example` documents the
variables with empty values. Browser QA for this repo uses claude-in-chrome.

<!-- stack:begin (managed by the stack plugin; edit via /stack:remember or by hand, keep the markers) -->

## Stack

- scope: pmaxhogan
- mode: auth.web.password=no
- mode: deploy.target=nas
- mode: deps.dependabot-mechanism=native
- mode: repo.no-protection=required-checks-ruleset-after-acceptance
- mode: stack.type=node-ts
- mode: test.coverage-ratchet=ruleset

<!-- stack:end -->
