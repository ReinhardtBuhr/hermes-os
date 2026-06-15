/*
 * Hermes OS — install as a macOS LaunchAgent (the "never offline" fix).
 *
 * `npm run dev` ties Hermes to a terminal or app session: close the laptop,
 * quit the app, or hit a crash loop and the dashboard is dead by morning.
 * This installs com.hermes.os into ~/Library/LaunchAgents with KeepAlive,
 * so launchd (macOS itself) starts Hermes at login and resurrects it every
 * time it exits, forever. The launcher keeps self-healing its two children
 * (backend + vite) with backoff; launchd keeps the launcher alive.
 *
 * Usage:
 *   node scripts/install-service.cjs            install (or update) + start
 *   node scripts/install-service.cjs restart    force a clean restart
 *   node scripts/install-service.cjs uninstall  stop + remove the service
 *
 * Old-Node-compatible syntax on purpose (the default `node` here is v12).
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var execSync = require('child_process').execSync;

var LABEL = 'com.hermes.os';
var ROOT = path.join(__dirname, '..');
var PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
var PLIST_PATH = path.join(PLIST_DIR, LABEL + '.plist');
var LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'hermes-os.log');

// The guardian: an independent watchdog LaunchAgent that health-checks
// :3210/:5210 and revives (or reinstalls) com.hermes.os when it's hung,
// port-stolen, or missing — failures KeepAlive alone can't see.
var GUARD_LABEL = 'com.hermes.guardian';
var GUARD_PLIST_PATH = path.join(PLIST_DIR, GUARD_LABEL + '.plist');
var GUARD_LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'hermes-guardian.log');

function findGoodNode() {
  // Homebrew node FIRST, always: better-sqlite3 is compiled against it.
  // Pinning process.execPath here once produced a plist locked to an nvm
  // v22 → ERR_DLOPEN_FAILED crash-loop (NODE_MODULE_VERSION mismatch).
  // The canonical Hermes runtime is /opt/homebrew/bin/node.
  var candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
  try {
    var major = parseInt(process.versions.node.split('.')[0], 10);
    if (major >= 18) candidates.push(process.execPath);
  } catch (e) {}
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
  }
  return process.execPath;
}

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null; // callers treat null as "that's fine"
  }
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var NODE = findGoodNode();
var UID = sh('id -u') || String(process.getuid ? process.getuid() : 501);
var TARGET = 'gui/' + UID + '/' + LABEL;

function buildPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>' + LABEL + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>' + xmlEscape(NODE) + '</string>',
    '    <string>' + xmlEscape(path.join(ROOT, 'scripts', 'launch.cjs')) + '</string>',
    '    <string>all</string>',
    '  </array>',
    '  <key>WorkingDirectory</key><string>' + xmlEscape(ROOT) + '</string>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    '  <key>ProcessType</key><string>Interactive</string>',
    '  <key>StandardOutPath</key><string>' + xmlEscape(LOG_PATH) + '</string>',
    '  <key>StandardErrorPath</key><string>' + xmlEscape(LOG_PATH) + '</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function buildGuardianPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>' + GUARD_LABEL + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>' + xmlEscape(NODE) + '</string>',
    '    <string>' + xmlEscape(path.join(ROOT, 'scripts', 'guardian.cjs')) + '</string>',
    '  </array>',
    '  <key>WorkingDirectory</key><string>' + xmlEscape(ROOT) + '</string>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    '  <key>StandardOutPath</key><string>' + xmlEscape(GUARD_LOG_PATH) + '</string>',
    '  <key>StandardErrorPath</key><string>' + xmlEscape(GUARD_LOG_PATH) + '</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function stopService() {
  // bootout is the modern call; fall back to unload for older macOS.
  if (sh('launchctl bootout ' + TARGET) === null) {
    sh('launchctl unload ' + PLIST_PATH);
  }
}

function startService() {
  var ok = sh('launchctl bootstrap gui/' + UID + ' ' + JSON.stringify(PLIST_PATH));
  if (ok === null) {
    // Older interface; -w clears any disabled flag.
    if (sh('launchctl load -w ' + JSON.stringify(PLIST_PATH)) === null) {
      // bootstrap can also fail because it is already loaded — kickstart it.
      sh('launchctl kickstart -k ' + TARGET);
    }
  }
}

function stopGuardian() {
  if (sh('launchctl bootout gui/' + UID + '/' + GUARD_LABEL) === null) {
    sh('launchctl unload ' + GUARD_PLIST_PATH);
  }
}

function startGuardian() {
  var ok = sh('launchctl bootstrap gui/' + UID + ' ' + JSON.stringify(GUARD_PLIST_PATH));
  if (ok === null) {
    if (sh('launchctl load -w ' + JSON.stringify(GUARD_PLIST_PATH)) === null) {
      sh('launchctl kickstart -k gui/' + UID + '/' + GUARD_LABEL);
    }
  }
}

var mode = process.argv[2] || 'install';

if (mode === 'uninstall') {
  stopGuardian(); // guardian first, or it would resurrect what we remove
  try { fs.unlinkSync(GUARD_PLIST_PATH); } catch (e) {}
  stopService();
  try { fs.unlinkSync(PLIST_PATH); } catch (e) {}
  console.log('Hermes OS service + guardian removed. (Processes on :5210/:3210 were stopped.)');
  process.exit(0);
}

if (!fs.existsSync(PLIST_DIR)) fs.mkdirSync(PLIST_DIR, { recursive: true });
fs.writeFileSync(PLIST_PATH, buildPlist());
fs.writeFileSync(GUARD_PLIST_PATH, buildGuardianPlist());
console.log('Wrote ' + PLIST_PATH);
console.log('Wrote ' + GUARD_PLIST_PATH);
console.log('Using node: ' + NODE);

stopService(); // clean slate whether installing fresh or updating
startService();
stopGuardian();
startGuardian();

console.log('');
console.log('✓ Hermes OS is now a login service (' + LABEL + ') with a guardian (' + GUARD_LABEL + ').');
console.log('  - starts automatically when you log in');
console.log('  - launchd restarts it if it ever dies — no more "offline" mornings');
console.log('  - the guardian health-checks :3210/:5210 every 45s and revives/reinstalls the service');
console.log('  - UI  → http://localhost:5210   API → http://localhost:3210');
console.log('  - logs → ' + LOG_PATH + '  ·  guardian → ' + GUARD_LOG_PATH);
console.log('');
console.log('Manage it with: npm run service:restart | service:logs | service:uninstall');
