import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
	test: {
		globals: true,
	},
	resolve: {
		alias: {
			src: resolve(__dirname, 'src'),
		},
	},
})
