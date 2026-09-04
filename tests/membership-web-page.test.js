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
assert.match(html, /Private creator setup link/, 'creator links should be rendered in the page');
assert.doesNotMatch(match[1], /prompt\('Send this private one-time setup link/, 'creator links should not rely on a browser prompt');

console.log('membership web page script test passed');
