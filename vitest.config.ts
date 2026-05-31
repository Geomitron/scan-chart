import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
	test: {
		globals: true,
		include: ['test/unit/**/*.test.ts'],
	},
	resolve: {
		alias: {
			src: resolve(__dirname, 'src'),
		},
	},
})
