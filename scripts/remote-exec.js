// Tiny utility: exec a command on a remote shadow and print stdout+stderr.
// Usage: node scripts/remote-exec.js <home|xps|office> "<command>"
const http = require('http');

const TARGETS = {
  office: { url: 'http://***REDACTED-IP***:7784', token: '***REDACTED-TOKEN***' },
  home:   { url: 'http://***REDACTED-IP***:7785', token: '***REDACTED-TOKEN***' },
  xps:    { url: 'http://***REDACTED-IP***:7786',  token: '***REDACTED-TOKEN***' },
};
const ROLE = process.argv[2];
const CMD  = process.argv[3];
if (!ROLE || !TARGETS[ROLE] || !CMD) {
  console.error('usage: node scripts/remote-exec.js <home|xps|office> "<command>"');
  process.exit(2);
}
const T = TARGETS[ROLE];
const payload = JSON.stringify({ command: CMD, cwd: 'C:\\dev\\web-terminal', timeout: 60000 });
const u = new URL(T.url + '/api/exec');
const req = http.request({
  hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
  headers: { 'Authorization': 'Bearer ' + T.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  timeout: 70000,
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const o = JSON.parse(d);
      if (o.stdout) process.stdout.write(o.stdout);
      if (o.stderr) process.stderr.write(o.stderr);
      process.exit(o.exitCode || 0);
    } catch (e) {
      console.error('parse err:', e.message);
      process.stderr.write(d);
      process.exit(1);
    }
  });
});
req.on('error', e => { console.error('req err:', e.message); process.exit(1); });
req.write(payload);
req.end();
