import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

it('mantiene VERSION igual a la versión del package.json', () => {
  const paquete = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  expect(VERSION).toBe(paquete.version);
});
