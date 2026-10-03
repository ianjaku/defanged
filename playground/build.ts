/** Builds the playground into playground/dist: the page, the icon, and one browser bundle. */
import { cp, mkdir, rm } from 'node:fs/promises';

const root = import.meta.dir;
await rm(`${root}/dist`, { recursive: true, force: true });
await mkdir(`${root}/dist`, { recursive: true });
const result = await Bun.build({
  entrypoints: [`${root}/src/main.ts`],
  outdir: `${root}/dist`,
  naming: 'app.js',
  target: 'browser',
  format: 'esm',
  minify: true,
  sourcemap: 'none',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp(`${root}/public`, `${root}/dist`, { recursive: true });
const size = Bun.file(`${root}/dist/app.js`).size;
console.log(`playground/dist ready, app.js ${(size / 1024).toFixed(0)} KB`);
