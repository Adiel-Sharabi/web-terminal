// Fix Claude hooks to use HTTP type (no subprocess, no console flash)
const fs = require("fs");
const os = require("os");
const f = os.homedir() + "/.claude/settings.json";
const s = JSON.parse(fs.readFileSync(f, "utf8"));
const hook = {hooks:[{type:"http",url:"http://127.0.0.1:7681/api/hook",headers:{"X-WT-Session-ID":"$WT_SESSION_ID"},allowedEnvVars:["WT_SESSION_ID"]}]};
s.hooks = {UserPromptSubmit:[hook],SubagentStart:[hook],Notification:[hook],Stop:[hook]};
fs.writeFileSync(f, JSON.stringify(s, null, 2));
console.log("done");
