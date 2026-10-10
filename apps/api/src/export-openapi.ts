/** Ekspor spesifikasi OpenAPI ke docs/11-API-openapi.json (npm run openapi). */
import { writeFileSync } from 'node:fs';
import { buildApp } from './app.js';

const app = await buildApp({ logger: false });
await app.ready();
const spec = app.swagger();
writeFileSync(new URL('../../../docs/11-API-openapi.json', import.meta.url), JSON.stringify(spec, null, 1));
console.log(`${Object.keys(spec.paths ?? {}).length} paths`);
await app.close();
