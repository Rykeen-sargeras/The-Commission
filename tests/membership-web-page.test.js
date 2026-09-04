'use strict';

const assert = require('assert');
const { adminPage } = require('../membership_web');

const html = adminPage();
const match = html.match(/<script>([\s\S]*?)<\/script>/i);

assert.ok(match, 'membership admin page should include its client script');
assert.doesNotThrow(
    () => new Function(match[1]),
    'membership admin page client script should be valid JavaScript',
);
assert.match(match[1], /document\.getElementById\('add'\)/, 'add-streamer handler should use an explicit DOM reference');
assert.match(match[1], /addButton\.onclick=/, 'add-streamer button should receive its click handler');

console.log('membership web page script test passed');
