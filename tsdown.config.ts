import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    '*': ['src/adapters/*.ts', '!src/adapters/*.test.ts'],
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  exports: true,
})
