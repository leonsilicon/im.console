import { defineConfig } from 'tsdown';

export default defineConfig([
	{
		entry: { 'runtime/index': 'src/runtime/index.ts' },
		format: ['esm', 'cjs'],
		platform: 'neutral',
		dts: true,
		clean: true,
	},
	{
		entry: { 'plugin/index': 'src/plugin/index.ts' },
		format: ['esm', 'cjs'],
		platform: 'node',
		dts: true,
	},
]);
