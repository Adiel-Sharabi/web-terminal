# Update Terminal

Commit, push, and deploy changes to the web-terminal project across all servers.

## Steps

1. **Pre-commit gates** (from CLAUDE.md):
   - Security review of changed files
   - Run `npx playwright test` — all must pass
   - Run `node -c server.js` — syntax check
   - Update README.md if new features were added

2. **Commit and push**:
   ```bash
   cd $PROJECT_DIR
   git add <changed files>
   git commit -m "<message>

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
   git push origin master
   ```

3. **Restart local server**:
   ```bash
   netstat -ano | grep ":7681" | grep LISTEN
   # get PID from output
   taskkill //PID <pid> //F && sleep 1 && cd $PROJECT_DIR && node server.js &
   ```

4. **Remind user** to pull and restart on remote servers (XPS, Office, etc.)

## Notes
- Restore `config.json` from backup after tests if needed (`cp config.json.bak config.json`)
- Clean up any test sessions leaked into `sessions.json`
- Never commit `config.json`, `api-tokens.json`, `cluster-tokens.json`, or `.session-secret`
