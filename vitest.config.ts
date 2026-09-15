import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						remoteBindings: false,
						wrangler: { configPath: './wrangler.jsonc' },
						miniflare: { isolatedStorage: true }
					})
				],
				test: {
					name: 'unit',
					include: ['tests/*.spec.ts'],
					maxWorkers: process.env.CI ? 1 : 2,
					testTimeout: 15000
				}
			},
			{
				// what workerd cannot host: the CLI, the publish client over a mocked API, node-only fs
				test: {
					name: 'node',
					include: ['tests/node/*.spec.ts'],
					environment: 'node',
					maxWorkers: process.env.CI ? 1 : 2
				}
			},
			{
				// installs real interpreter builds from npm, so it is slow and serial
				test: {
					name: 'runtimes',
					include: ['tests/runtimes/*.spec.ts'],
					environment: 'node',
					testTimeout: 120000,
					maxWorkers: 1
				}
			},
			{
				// asserts properties of the cost law, never magnitudes; absolute ns belong to a deploy
				test: {
					name: 'bench',
					include: ['tests/bench/*.spec.ts'],
					environment: 'node',
					testTimeout: 300000,
					maxWorkers: 1,
					fileParallelism: false
				}
			}
		],
		coverage: {
			// istanbul, never v8: the v8 provider reads the node inspector and attributes zero from
			// inside workerd, which would silently zero the largest project
			provider: 'istanbul',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
