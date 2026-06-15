/*
 * Hermes OS — guardian (com.hermes.guardian)
 *
 * A tiny external watchdog, independent of the main service. Every 45s
 * it health-checks the backend (:3210/api/health) and the UI (:5210).
 * Two consecutive failures → it revives com.hermes.os:
 *   - plist present  → `launchctl kickstart -k` (force restart)
 *   - plist MISSING  → re-runs install-service.cjs (full reinstall)
 *
 * Why it exists: launchd KeepAlive resurrects a *crashed* launcher, but
 * it cannot see a hung process, a stolen port, a crash-looping backend
 * child behind a healthy launcher, or a service that was unloaded and
 * never reinstalled (exactly how the agents "went offline" on
 * 2026-06-12). The guardian closes every one of those gaps, so the
 * operator never has to open a terminal — or ask an AI — to fix it.
 *
 * Old-Node-compatible syntax on purpose (it must run anywhere).
 */
'use strict';

var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var execSync = require('child_process').execSync;

var MAIN_LABEL = 'com.hermes.os';
var MAIN_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', MAIN_LABEL + '.plist');
var INSTALLER = path.join(__dirname, 'install-service.cjs');
var INTERVAL_MS = 45000;
var STRIKES_TO_ACT = 2;       // ~90s of confirmed downtime before acting
var ACTION_COOLDOWN_MS = 120000; // give each revive 2 min to take effect

var strikes = 0;
var lastAction = 0;

function checkHost(host, port, p) {
  return new Promise(function (resolve) {
    var req = http.get({ host: host, port: port, path: p, timeout: 6000 }, function (res) {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', function () { resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
  });
}

// Vite binds IPv6 ::1 only on this machine while the backend binds IPv4.
// Checking a single stack once produced a false "ui down" verdict every
// tick → kickstart loop that restarted Hermes (and any live council)
// every ~2 minutes. Healthy = reachable on EITHER stack.
function check(port, p) {
  return checkHost('127.0.0.1', port, p).then(function (ok4) {
    if (ok4) return true;
    return checkHost('::1', port, p);
  });
}

function uid() {
  try { return execSync('id -u', { encoding: 'utf8' }).trim(); } catch (e) { return '501'; }
}

function revive() {
  try {
    if (!fs.existsSync(MAIN_PLIST)) {
      console.log('[guardian] main service plist missing — reinstalling ' + MAIN_LABEL);
      execSync(JSON.stringify(process.execPath) + ' ' + JSON.stringify(INSTALLER), { stdio: 'inherit' });
    } else {
      console.log('[guardian] kickstarting ' + MAIN_LABEL);
      execSync('/bin/launchctl kickstart -k gui/' + uid() + '/' + MAIN_LABEL, { stdio: 'inherit' });
    }
  } catch (e) {
    console.log('[guardian] revive failed: ' + (e && e.message));
  }
}

function tick() {
  Promise.all([check(3210, '/api/health'), check(5210, '/')]).then(function (r) {
    var apiOk = r[0];
    var uiOk = r[1];
    if (apiOk && uiOk) { strikes = 0; return; }
    strikes += 1;
    console.log('[guardian] ' + new Date().toISOString()
      + ' unhealthy (api=' + apiOk + ' ui=' + uiOk + ') — strike ' + strikes + '/' + STRIKES_TO_ACT);
    if (strikes < STRIKES_TO_ACT) return;
    if (Date.now() - lastAction < ACTION_COOLDOWN_MS) return;
    strikes = 0;
    lastAction = Date.now();
    revive();
  });
}

console.log('[guardian] watching Hermes OS (api :3210 · ui :5210) every ' + INTERVAL_MS / 1000 + 's');
setInterval(tick, INTERVAL_MS);
tick();
