// Tiny utility: exec a command on a remote shadow and print stdout+stderr.
// Usage: node scripts/remote-exec.js <home|xps|office> "<command>"
const http = require('http');

const TARGETS = {
  office: { url: 'http://100.75.82.89:7784', token: 'ea23ecc31eb999971ad460593a5e5b1f9d4dab9a0da92940037262285f666bbe' },
  home:   { url: 'http://100.79.226.100:7785', token: '8727e858f500927c0dd54968a79d03247ee92aa042bf20a89ad7476f22431fa7' },
  xps:    { url: 'http://100.67.238.93:7786',  token: '4a1023df028ef87c7dc508a6d56b7729bc64b1bf40883af6ca6dbd6e9f8a18a5' },
};
const ROLE = process.argv[2];
const CMD  = process.argv[3];
if (!ROLE || !TARGETS[ROLE] || !CMD) {
  console.error('usage: node scripts/remote-exec.js <home|xps|office> "<command>"');
  process.exit(2);
}
const T = TARGETS[ROLE];
const payload = JSON.stringify({ command: CMD, cwd: 'C:\\dev\\web-terminal-shadow', timeout: 60000 });
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
