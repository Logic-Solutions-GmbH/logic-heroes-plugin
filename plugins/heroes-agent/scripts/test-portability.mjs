#!/usr/bin/env node
import assert from 'node:assert/strict';
import { collectScannableTrackedPaths } from './portability-paths.mjs';

const errors = [];
const paths = collectScannableTrackedPaths(
  [
    '100644 abcdef 0\tREADME.md',
    '120000 fedcba 0\tplugins/heroes-agent/unsafe-link',
  ],
  ['README.md', 'plugins/heroes-agent/unsafe-link'],
  errors,
);

assert.deepEqual(paths, ['README.md']);
assert.deepEqual(errors, ['tracked-symlink: plugins/heroes-agent/unsafe-link']);
console.log('Portability path checks passed (tracked symlinks rejected and skipped).');
