import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

// Exercise the real config against forbidden source shapes. A disabled or
// accidentally narrowed rule must fail even when today's app still passes lint.
const eslint = new ESLint();
for (const [filePath, code, rule] of [
  ['src/pages.tsx', 'fetch("/api/v1/stats");', 'no-restricted-globals'],
  ['src/pages.tsx', 'window.fetch("/api/v1/stats");', 'no-restricted-syntax'],
  [
    'src/pages.tsx',
    'globalThis["fetch"]("/api/v1/stats");',
    'no-restricted-syntax',
  ],
  [
    'src/components/probe.tsx',
    'import { request } from "../api"; void request;',
    'no-restricted-imports',
  ],
  ['src/lib/probe.ts', 'console.log("payload");', 'no-console'],
]) {
  const [result] = await eslint.lintText(code, { filePath });
  assert(
    result.messages.some((message) => message.ruleId === rule),
    `${filePath}: restore ${rule} in eslint.config.js; the forbidden source was accepted`,
  );
}
const [allowed] = await eslint.lintText('fetch("/api/v1/stats");', {
  filePath: 'src/api.ts',
});
assert.equal(
  allowed.errorCount,
  0,
  'The API boundary must remain able to fetch.',
);
console.log('Frontend architecture policy regression checks passed.');
