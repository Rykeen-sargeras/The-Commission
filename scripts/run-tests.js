'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testsDirectory = path.join(__dirname, '..', 'tests');
const testFiles = fs
  .readdirSync(testsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => entry.name)
  .sort();

if (testFiles.length === 0) {
  console.error('No test files were found.');
  process.exit(1);
}

for (const testFile of testFiles) {
  console.log(`\n> ${testFile}`);

  const result = spawnSync(process.execPath, [path.join(testsDirectory, testFile)], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${testFiles.length} test files passed.`);
