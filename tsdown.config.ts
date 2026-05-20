import { defineConfig } from 'tsdown';

export default defineConfig([
	{
		entry: { 'node/index': 'src/node/index.ts' },
		format: ['esm'],
		platform: 'node',
		dts: true,
		clean: true,
	},
	{
		entry: { 'cjs/index': 'src/cjs/index.ts' },
		format: ['cjs'],
		platform: 'node',
		dts: true,
	},
	{
		entry: { 'bun/index': 'src/bun/index.ts' },
		format: ['esm'],
		platform: 'node',
		dts: true,
	},
	{
		entry: { 'runtime/index': 'src/runtime/index.ts' },
		format: ['esm', 'cjs'],
		platform: 'neutral',
		dts: true,
	},
	{
		entry: { 'runtime-react-native/index': 'src/runtime-react-native/index.ts' },
		format: ['esm', 'cjs'],
		platform: 'neutral',
		dts: true,
	},
	{
		entry: { 'plugin/index': 'src/plugin/index.ts' },
		format: ['esm', 'cjs'],
		platform: 'node',
		dts: true,
	},
]);
