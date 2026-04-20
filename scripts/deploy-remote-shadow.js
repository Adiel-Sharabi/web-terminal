// Deploy latest feature/direct-terminal + enable WT_LATENCY_DEBUG on a remote shadow.
// Usage: node scripts/deploy-remote-shadow.js <home|xps>
//
// Runs remotely via /api/exec on the target shadow (since it's the one with git + shadow dir).
const http = require('http');

const ROLE = process.argv[2];
if (!ROLE || !['home','xps'].includes(ROLE)) {
  console.error('usage: node scripts/deploy-remote-shadow.js <home|xps>');
  process.exit(2);
}

const TARGETS = {
  home: { url: 'http://100.79.226.100:7785', token: '8727e858f500927c0dd54968a79d03247ee92aa042bf20a89ad7476f22431fa7', pipe: 'home' },
  xps:  { url: 'http://100.67.238.93:7786',  token: '4a1023df028ef87c7dc508a6d56b7729bc64b1bf40883af6ca6dbd6e9f8a18a5', pipe: 'xps' },
};
const T = TARGETS[ROLE];

function httpJson(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 120000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function exec(cmd) {
  console.log('$ ' + cmd);
  const r = await httpJson('POST', T.url + '/api/exec', T.token, { command: cmd, cwd: 'C:\\dev\\web-terminal-shadow', timeout: 120000 });
  if (r.status !== 200) {
    console.error('exec failed:', r.status, r.body);
    throw new Error('exec ' + r.status);
  }
  if (r.body.stdout) process.stdout.write(r.body.stdout);
  if (r.body.stderr) process.stderr.write(r.body.stderr);
  return r.body;
}

(async () => {
  // Step 1: fetch + hard-reset to latest feature/direct-terminal
  await exec('git -C C:/dev/web-terminal fetch origin feature/direct-terminal');
  await exec('git -C C:/dev/web-terminal-shadow fetch origin feature/direct-terminal');
  await exec('git -C C:/dev/web-terminal-shadow reset --hard origin/feature/direct-terminal');

  // Step 2: rewrite start-shadow.vbs so WT_LATENCY_DEBUG=1 is exported before monitor.js
  // (Idempotent: we just write the file wholesale.)
  const vbs = `' Shadow cluster launcher (${ROLE}) - isolated pipe, own config/state.\r\n` +
              `Set objFSO = CreateObject("Scripting.FileSystemObject")\r\n` +
              `Set objShell = CreateObject("WScript.Shell")\r\n` +
              `objShell.CurrentDirectory = objFSO.GetParentFolderName(WScript.ScriptFullName)\r\n` +
              `objShell.Environment("PROCESS")("WT_WORKER_PIPE") = "\\\\.\\pipe\\web-terminal-shadow-${T.pipe}"\r\n` +
              `objShell.Environment("PROCESS")("WT_LATENCY_DEBUG") = "1"\r\n` +
              `objShell.Run "node monitor.js", 0, False\r\n`;
  const payload = Buffer.from(vbs, 'utf8').toString('base64');
  // Use powershell to decode and write (portable, and /api/exec handles arbitrary commands).
  const psCmd = `powershell -NoProfile -Command "[IO.File]::WriteAllText('C:/dev/web-terminal-shadow/start-shadow.vbs', [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))"`;
  await exec(psCmd);

  // Step 3: restart — kill existing shadow monitor/server/worker then relaunch via wscript.
  // Only kill node procs whose cmdline includes 'web-terminal-shadow', NOT generic node.
  const killPs = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { \\$_.CommandLine -like '*web-terminal-shadow*' } | ForEach-Object { Stop-Process -Id \\$_.ProcessId -Force -ErrorAction SilentlyContinue }"`;
  await exec(killPs);
  // Wait briefly so /api/exec parent process isn't ripped out from under us (it's the server we're about to restart)
  // /api/exec runs under the shadow server; once we kill it, the response dies too.
  // So: issue the kill+restart as a SINGLE detached command that survives the parent's death.
  const restartCmd = `powershell -NoProfile -Command "Start-Sleep -Seconds 2; cd C:/dev/web-terminal-shadow; wscript.exe start-shadow.vbs"`;
  // Fire-and-forget via spawn so /api/exec doesn't wait on it
  await exec(`powershell -NoProfile -Command "Start-Process -FilePath powershell -ArgumentList '-NoProfile -Command &{ Start-Sleep -Seconds 2; Set-Location C:/dev/web-terminal-shadow; wscript.exe start-shadow.vbs }' -WindowStyle Hidden"`);

  // Step 4: poll the shadow until it reappears.
  console.log('[deploy] waiting for shadow to come back on ' + T.url + ' ...');
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const r = await httpJson('GET', T.url + '/api/version', T.token);
      if (r.status === 200) {
        console.log('[deploy] back online — version=', r.body);
        process.exit(0);
      }
    } catch {}
    await new Promise(res => setTimeout(res, 1000));
  }
  console.error('[deploy] shadow did not come back within 30s');
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
