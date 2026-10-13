// hey-api usa la API de JS de TypeScript, que TS 7 no trae: el generador corre con TS 6 fijado aparte.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const spec = process.env.SIFENDE_OPENAPI ?? 'https://api.sifende.com.py/v3/api-docs';

execFileSync(
  'npm',
  [
    'exec',
    '--yes',
    '--package=@hey-api/openapi-ts@0.99.0',
    '--package=typescript@6.0.3',
    '--',
    'openapi-ts',
    '--input',
    spec,
    '--output',
    'src/generado',
    '--plugins',
    '@hey-api/typescript',
  ],
  { stdio: 'inherit' },
);

// El índice generado importa sin extensión, lo que NodeNext rechaza; el SDK importa types.gen.js directo.
rmSync('src/generado/index.ts', { force: true });
