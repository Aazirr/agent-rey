# Agent Rey development phases

## Existing product (historical status in mvp-scope.md)

- [x] P0: local daemon and authentication
- [x] P1: mobile conversation UI
- [x] P2: project/session management
- [x] P3: reconnect and replay
- [x] P4: deployment and autostart
- [x] P5: thin VS Code client

## P6: reusable Codex frontend worker

- [x] Specify isolated MCP worker architecture in codex-frontend-worker.md
- [x] Implement bounded tasks, preserved worktrees and scoped file-only permissions
- [x] Add persistent account circuit and explicit Claude-or-Codex handoff decision
- [x] Test provider failures, cancellation, worktree containment and MCP protocol
- [x] Install user-level MCP configuration and reusable skill
- [x] Verify live account access and a scoped frontend edit (2026-09-26)
- [x] Run workspace regression checks
- [x] Commit and push reviewed changes to Aazirr/agent-rey

## Verification record — 2026-09-26

- [x] 25 bridge tests: isolated checkout, dirty-root rejection, scoped file hooks,
  junction/traversal/credential guards, sanitized environment, persisted provider
  failures, user-choice outputs, explicit probe recovery, cancellation, stale workers,
  MCP handshake and cross-process blocked-account reporting
- [x] Workspace `pnpm typecheck`, `pnpm build`, and `pnpm test` passed; bridge `.mjs`
  checks are syntax checks, while existing TypeScript packages are typechecked
- [x] Global skill passed the bundled skill validator; MCP config parsed by Codex CLI
- [x] Live tools-disabled Claude account probe succeeded
- [x] Live frontend task edited only `src/status.html` in a dedicated test worktree
- [x] Live feedback resumed the same Claude session and added the requested button ID
- [x] Original test-project checkout remained unchanged
- [x] Provider outages/disabled accounts tested with simulated SDK streams, not by
  disabling the user's real account; no browser visual acceptance claimed for fixture
- [ ] User restarts Codex/MCP connection to load tools in their normal task UI

## P7: pin frontend worker to Opus 5.5

- [x] Set user-local model to exact `claude-opus-5-5` for all projects
- [x] Upgrade only bridge SDK to 0.3.283 for the required Claude Code runtime
- [x] Verify SDK metadata reports Claude Code 2.1.283 and config loads exact model ID
- [x] Pass 26 bridge tests, including exact model forwarding for new/resumed tasks
- [x] Pass workspace typecheck, build and tests
- [x] Commit and push scoped dependency/documentation changes
- [ ] Verify live Opus 5.5 account entitlement on the next explicitly requested Claude run
