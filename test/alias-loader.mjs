// Lets node:test import app code directly: resolves the "@/..." path alias from tsconfig and
// extensionless imports of local .ts files. Registered by `npm test` via --import.
import { register } from 'node:module';

register('./alias-hooks.mjs', import.meta.url);
