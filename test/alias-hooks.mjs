import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  // pdf-parse's entry file runs a debug harness (reading a bundled test PDF) whenever it isn't
  // loaded via require(), which is how ESM imports it. Its library file has no harness.
  if (specifier === 'pdf-parse') return nextResolve('pdf-parse/lib/pdf-parse.js', context);

  let target = null;
  if (specifier.startsWith('@/')) target = new URL(specifier.slice(2), root);
  else if (/^\.{1,2}\//.test(specifier) && context.parentURL?.endsWith('.ts')) target = new URL(specifier, context.parentURL);

  if (target && !/\.[cm]?[jt]sx?$/.test(target.pathname)) {
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const candidate = fileURLToPath(target) + ext;
      if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(target ? target.href : specifier, context);
}
