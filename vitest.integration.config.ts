import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		include: ['test/integration/**/*.test.ts'],
	},
	resolve: {
		alias: {
			src: resolve(__dirname, 'src'),
		},
	},
})
