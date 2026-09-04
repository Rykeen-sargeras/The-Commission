'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'railway_start.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'railway', 'ui.js'), 'utf8');

assert.match(
    server,
    /key==='DISCORD_TOKEN'&&railwayValue\?railwayValue/,
    'the Railway Discord token must override any dashboard-saved value',
);
assert.match(
    ui,
    /autocomplete="new-password"[^']*data-lpignore="true"/,
    'dashboard secret fields must opt out of password-manager autofill',
);

console.log('Railway configuration safety tests passed.');
