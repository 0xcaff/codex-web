# Repository workflow

- Install dependencies without executing the runtime download: `npm ci --ignore-scripts`.
- Run focused security regressions with `npm test`.
- Run the update signature regression with `cd scripts/fetch_updates && uv run --locked python -m unittest test_fetch_updates.py`.
- Run the tracked checks with `npm run check`.
- `scratch/` contains generated upstream Codex desktop artifacts and must stay untracked.
- The server must remain loopback-only for tunneled deployments. Configure browser origins with `CODEX_WEB_ALLOWED_ORIGINS` and raw browser file roots with `CODEX_WEB_FILE_ROOTS`.
- Do not remove or weaken the archive SHA-256 verification in `scripts/prepare`.
