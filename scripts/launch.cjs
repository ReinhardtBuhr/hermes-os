/*
 * Hermes OS launcher.
 * This machine's default `node` (via nvm) is ancient (v12), which cannot run
 * Vite or the better-sqlite3 build. This script is intentionally written in
 * old-Node-compatible syntax (no optional chaining / nullish coalescing) so it
 * runs under v12, then re-spawns the backend and Vite with a modern Node.
 *
 * Usage: node scripts/launch.cjs [backend|frontend|all]   (default: all)
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var spawn = require('child_process').spawn;
var execSync = require('child_process').execSync;

var ROOT = path.join(__dirname, '..');
var BACKEND_PORT = Number(process.env.HERMES_PORT) || 3210;
var UI_PORT = 5210;

// Kill whatever stale process still holds one of our ports (a crashed dev
// server, a detached backend left by an agent session, …) so `npm run dev`
// is always one command that just works. These ports belong to Hermes OS.
// lsof lives in /usr/sbin on macOS, which launchd's restricted PATH may
// not include — resolve it explicitly or port-clearing silently no-ops.
var LSOF = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';

function clearPort(port) {
  var out = '';
  try {
    out = execSync(LSOF + ' -ti tcp:' + port + ' || true', { encoding: 'utf8', shell: '/bin/sh' }).trim();
  } catch (e) { return; }
  if (!out) return;
  var pids = out.split(/\s+/);
  for (var i = 0; i < pids.length; i++) {
    var pid = parseInt(pids[i], 10);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
      process.stdout.write('[launcher] cleared stale pid ' + pid + ' from port ' + port + '\n');
    } catch (e) {}
  }
  try { execSync('sleep 1'); } catch (e) {}
}

// better-sqlite3 was rebuilt against Homebrew Node (v24); prefer it so the
// native ABI matches. Fall back to any modern node we can find.
function findGoodNode() {
  var candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ];
  // Current node, if modern enough — AFTER homebrew, never before it:
  // unshifting it once locked the service to an nvm v22 whose ABI didn't
  // match the better-sqlite3 binary (ERR_DLOPEN_FAILED crash-loop).
  try {
    var major = parseInt(process.versions.node.split('.')[0], 10);
    if (major >= 18) candidates.push(process.execPath);
  } catch (e) {}
  // nvm installs (newest first).
  try {
    var nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      var versions = fs.readdirSync(nvmDir).sort().reverse();
      for (var i = 0; i < versions.length; i++) {
        var m = parseInt(String(versions[i]).replace(/^v/, '').split('.')[0], 10);
        if (m >= 18) candidates.push(path.join(nvmDir, versions[i], 'bin', 'node'));
      }
    }
  } catch (e) {}

  for (var j = 0; j < candidates.length; j++) {
    try { if (candidates[j] && fs.existsSync(candidates[j])) return candidates[j]; } catch (e) {}
  }
  return process.execPath;
}

var NODE = findGoodNode();
var children = {};
var restarts = {};
var shuttingDown = false;

function run(name, args) {
  var child = spawn(NODE, args, { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'] });
  var startedAt = Date.now();
  function prefixer(stream, out) {
    var buf = '';
    stream.on('data', function (chunk) {
      buf += chunk.toString();
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) out.write('[' + name + '] ' + lines[i] + '\n');
    });
  }
  prefixer(child.stdout, process.stdout);
  prefixer(child.stderr, process.stderr);
  child.on('exit', function (code) {
    process.stdout.write('[' + name + '] exited with code ' + code + '\n');
    delete children[name];
    // Self-heal: NEVER give up on a child. A capped retry count once left the
    // backend dead after an overnight crash loop ("it says offline") — instead
    // we restart forever with exponential backoff (2s → 60s), and a child that
    // stayed healthy for 60s+ resets its backoff to fast restarts.
    if (!shuttingDown) {
      if (Date.now() - startedAt > 60000) restarts[name] = 0;
      restarts[name] = (restarts[name] || 0) + 1;
      var delay = Math.min(60000, 2000 * Math.pow(2, Math.min(restarts[name] - 1, 5)));
      process.stdout.write('[launcher] restarting ' + name + ' in ' + Math.round(delay / 1000) + 's (restart #' + restarts[name] + ')\n');
      setTimeout(function () {
        if (shuttingDown) return;
        if (name === 'backend') clearPort(BACKEND_PORT);
        if (name === 'vite') clearPort(UI_PORT);
        run(name, args);
      }, delay);
    }
  });
  children[name] = child;
  return child;
}

function shutdown() {
  shuttingDown = true;
  for (var name in children) {
    try { children[name].kill('SIGTERM'); } catch (e) {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

var mode = process.argv[2] || 'all';
process.stdout.write('Hermes OS launcher — using node: ' + NODE + '\n');

if (mode === 'backend') {
  clearPort(BACKEND_PORT);
  run('backend', [path.join('server', 'index.js')]);
} else if (mode === 'frontend') {
  clearPort(UI_PORT);
  run('vite', [path.join('node_modules', 'vite', 'bin', 'vite.js')]);
} else {
  clearPort(BACKEND_PORT);
  clearPort(UI_PORT);
  run('backend', [path.join('server', 'index.js')]);
  run('vite', [path.join('node_modules', 'vite', 'bin', 'vite.js')]);
}
