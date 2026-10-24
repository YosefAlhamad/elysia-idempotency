import { $ } from 'bun'

await $`rm -rf dist`

const result = await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  packages: 'external',
  sourcemap: 'linked',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await $`bunx tsc -p tsconfig.build.json`
