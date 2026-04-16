// Run this ON the target server to test localhost PTY latency (no network)
// Usage: node tests/local-burst-test.js [token]
var WebSocket = require('ws');
var http = require('http');
var TOKEN = process.argv[2] || 'e3728ca208ee5e5d03163ccd4b8ceaa113d75ab442ffe4023e7343e45ec9e0f2';

http.get('http://localhost:7681/api/sessions', {headers:{Authorization:'Bearer '+TOKEN}}, function(res) {
  var d = ''; res.on('data', function(c){ d += c; }); res.on('end', function() {
    var sessions = JSON.parse(d);
    var sid = sessions.find(function(s){ return s.clients === 0; });
    if (!sid) { console.log('No free session'); process.exit(1); }
    console.log('Testing localhost burst on:', sid.name);
    var ws = new WebSocket('ws://localhost:7681/ws/' + sid.id + '?token=' + TOKEN);
    ws.on('open', function() {
      setTimeout(function() {
        ws.send(String.fromCharCode(3));
        setTimeout(function() {
          var results = [];
          var run = 0;
          function doBurst() {
            var msgs = [];
            var handler = function() { msgs.push(Date.now()); };
            ws.on('message', handler);
            var st = Date.now();
            for (var i = 0; i < 16; i++) ws.send(String.fromCharCode(97 + i));
            setTimeout(function() {
              ws.removeListener('message', handler);
              var last = msgs.length ? msgs[msgs.length-1] - st : -1;
              results.push(last);
              var flag = last > 200 ? ' <<<' : '';
              console.log('  #' + (run+1) + ': ' + last + 'ms' + flag);
              run++;
              if (run < 10) doBurst();
              else {
                ws.close();
                results.sort(function(a,b){return a-b;});
                var avg = Math.round(results.reduce(function(s,v){return s+v;},0)/10);
                var spikes = results.filter(function(v){return v>200;}).length;
                console.log('Summary: avg=' + avg + 'ms p50=' + results[5] + 'ms max=' + results[9] + 'ms spikes=' + spikes + '/10');
                process.exit(0);
              }
            }, 2000);
          }
          doBurst();
        }, 500);
      }, 1500);
    });
  });
});
