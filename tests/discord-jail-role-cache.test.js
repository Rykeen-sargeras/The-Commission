'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'discord_bot.js'), 'utf8');
const accessSource = fs.readFileSync(path.join(__dirname, '..', 'discord', 'staff_access.js'), 'utf8');

assert.match(source, /createStaffAccess\(Discord, CONFIG\)/);
assert.match(accessSource, /function configuredStaffRoleIds\(guild\)/);
assert.match(accessSource, /guild\.roles\.cache\.has\(id\)/);
assert.doesNotMatch(source, /\.\.\.staffPermissionOverwrites\(\)/);
assert.doesNotMatch(source, /staffMentions\((?:userId|user\.id|reporter\.id|targetUser\.id)\)/);
assert.strictEqual((source.match(/\.\.\.staffPermissionOverwrites\(guild\)/g) || []).length, 5);

console.log('discord jail role-cache tests passed');
