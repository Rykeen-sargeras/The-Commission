'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { publicPage, loginPage, privacyPage, termsPage } = require('../railway/ui');

const home = publicPage();
assert.match(home, /Welcome to The Commission/);
assert.match(home, /href="\/privacy"/);
assert.match(home, /href="\/terms"/);
assert.match(home, /href="\/control"/);
assert.doesNotMatch(home, /name="password"/);

const login = loginPage();
assert.match(login, /Commission Control Room/);
assert.match(login, /name="password"/);
assert.match(login, /href="\/privacy"/);
assert.match(login, /href="\/terms"/);

const privacy = privacyPage();
assert.match(privacy, /Privacy Policy/);
assert.match(privacy, /Information we process/);
assert.match(privacy, /Retention and deletion/);
assert.doesNotMatch(privacy, /name="password"/);

const terms = termsPage();
assert.match(terms, /Terms of Service/);
assert.match(terms, /Authorized use/);
assert.doesNotMatch(terms, /name="password"/);

const server = fs.readFileSync(path.join(__dirname, '..', 'railway_start.js'), 'utf8');
assert.match(server, /url\.pathname==='\/privacy'.*privacyPage\(\)/s);
assert.match(server, /url\.pathname==='\/terms'.*termsPage\(\)/s);
assert.match(server, /url\.pathname==='\/control'.*dashboardPage\(\)/s);
assert.match(server, /redirect\(res,'\/control'/);

console.log('public homepage, privacy policy, terms, and control-room boundary tests passed');
