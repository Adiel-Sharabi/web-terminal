// Fix Claude hooks to use HTTP type (no subprocess, no console flash)
// H1: hook endpoint requires X-WT-Hook-Token from .hook-token (exposed to
// spawned shells as the WT_HOOK_TOKEN env var).
const fs = require("fs");
const os = require("os");
const f = os.homedir() + "/.claude/settings.json";
const s = JSON.parse(fs.readFileSync(f, "utf8"));
const hook = {hooks:[{type:"http",url:"http://127.0.0.1:7681/api/hook",headers:{"X-WT-Session-ID":"$WT_SESSION_ID","X-WT-Hook-Token":"$WT_HOOK_TOKEN"},allowedEnvVars:["WT_SESSION_ID","WT_HOOK_TOKEN"]}]};
// All seven, and the set is not optional (this assignment REPLACES s.hooks):
//  - PreToolUse/PostToolUse are the working heartbeat — without them the 5-min
//    stale guard flips a busy session to Idle (#37).
//  - SubagentStart/SubagentStop are counted as a PAIR (#61). Installing Start
//    without Stop is worse than installing neither: the in-flight count only ever
//    grows, so the main agent's Stop is held forever and the session never reports
//    idle. Keep this list identical to the one in README.md.
const EVENTS = ["UserPromptSubmit","PreToolUse","PostToolUse","SubagentStart","SubagentStop","Notification","Stop"];
s.hooks = Object.fromEntries(EVENTS.map(e => [e, [hook]]));
fs.writeFileSync(f, JSON.stringify(s, null, 2));
console.log("done");
