import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import prettierConfig from 'eslint-config-prettier'

export default [
	{
		// The backtest harness and the test suite are linted too — they were added
		// after this config and would otherwise be silently skipped, which is how
		// the stray-token bug above went unnoticed for so long.
		files: ['src/**/*.ts', 'backtest/**/*.ts', 'tests/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			// [FIX] There was a stray `s` token here (`sourceType: "module", s`) which
			// made the whole config throw `ReferenceError: s is not defined` on load —
			// so `npm run lint` and `npm run check` had never actually run.
			sourceType: 'module',
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			'no-console': 'off',
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			// [FIX] The old config set `semi: ["error", "always"]`, which contradicts
			// .prettierrc (`semi: false`) — running both would have had them fighting
			// over every line. Formatting is prettier's job; eslint-config-prettier
			// (already a devDependency, previously unused) disables the rules that
			// overlap.
		},
	},
	prettierConfig,
]
