/*
 * Hermes OS — one-step Gemini brain connector.
 * Pre-selects the free personal-account OAuth method, then launches the
 * Gemini CLI interactively so you can sign in with your Google account.
 * After the browser sign-in, press Ctrl+C (or type /quit) to return.
 * ES2018-compatible so it runs under this machine's default Node.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var spawn = require('child_process').spawn;

var HOME = os.homedir();
var GEMINI_HOME = path.join(HOME, '.gemini');
var SETTINGS = path.join(GEMINI_HOME, 'settings.json');

function findGoodNodeDir() {
  var candidates = ['/opt/homebrew/bin', '/usr/local/bin'];
  try {
    var major = parseInt(process.versions.node.split('.')[0], 10);
    if (major >= 18) candidates.unshift(path.dirname(process.execPath));
  } catch (e) {}
  try {
    var nvmDir = path.join(HOME, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      var versions = fs.readdirSync(nvmDir).sort().reverse();
      for (var i = 0; i < versions.length; i++) {
        var m = parseInt(String(versions[i]).replace(/^v/, '').split('.')[0], 10);
        if (m >= 18) candidates.push(path.join(nvmDir, versions[i], 'bin'));
      }
    }
  } catch (e) {}
  for (var j = 0; j < candidates.length; j++) {
    try { if (fs.existsSync(path.join(candidates[j], 'node'))) return candidates[j]; } catch (e) {}
  }
  return path.dirname(process.execPath);
}

function findGemini(goodDir) {
  var dirs = [goodDir, '/opt/homebrew/bin', '/usr/local/bin'];
  var p = String(process.env.PATH || '').split(path.delimiter);
  dirs = dirs.concat(p);
  for (var i = 0; i < dirs.length; i++) {
    var cand = path.join(dirs[i], 'gemini');
    try { if (fs.existsSync(cand)) return cand; } catch (e) {}
  }
  return '';
}

// 1) Pre-select the free "Login with Google" auth method.
try {
  if (!fs.existsSync(GEMINI_HOME)) fs.mkdirSync(GEMINI_HOME, { recursive: true });
  var settings = {};
  if (fs.existsSync(SETTINGS)) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8') || '{}'); } catch (e) { settings = {}; }
  }
  if (!settings.security) settings.security = {};
  if (!settings.security.auth) settings.security.auth = {};
  settings.security.auth.selectedType = 'oauth-personal';
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  process.stdout.write('✓ Gemini auth method set to "Login with Google" (free personal account).\n');
} catch (e) {
  process.stdout.write('! Could not write ' + SETTINGS + ': ' + e.message + '\n');
}

// 2) Launch the Gemini CLI interactively for sign-in.
var goodDir = findGoodNodeDir();
var gemini = findGemini(goodDir);
if (!gemini) {
  process.stdout.write('\nThe Gemini CLI is not installed. Run:\n  npm install -g @google/gemini-cli\nthen run this again.\n');
  process.exit(1);
}

process.stdout.write('\nLaunching Gemini sign-in… a browser window will open.\n');
process.stdout.write('After you sign in, type /quit (or press Ctrl+C) to finish.\n\n');

var env = Object.assign({}, process.env);
env.PATH = goodDir + path.delimiter + (env.PATH || '');
env.GOOGLE_GENAI_USE_GCA = 'true';

var child = spawn(gemini, [], { stdio: 'inherit', env: env });
child.on('exit', function (code) {
  process.stdout.write('\n✓ Done. Back in Hermes OS, click "Test brain" in the console.\n');
  process.exit(code || 0);
});
