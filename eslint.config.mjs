import path from 'node:path'
import { fileURLToPath } from 'node:url'

import angular from '@angular-eslint/eslint-plugin'
import angularTemplate from '@angular-eslint/eslint-plugin-template'
import angularTemplateParser from '@angular-eslint/template-parser'
import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'
import preferArrow from 'eslint-plugin-prefer-arrow'

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url))

export default [
	{
		linterOptions: {
			reportUnusedDisableDirectives: 'off',
		},
	},
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'coverage/**',
			'regression-tests/**',
			'*.config',
		],
	},
	js.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: ['./tsconfig.json'],
				tsconfigRootDir,
			},
		},
		plugins: {
			'@angular-eslint': angular,
			'@typescript-eslint': tsPlugin,
			'prefer-arrow': preferArrow,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			...angular.configs.recommended.rules,
			'no-undef': 'off',
			'no-control-regex': 'off',
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/no-require-imports': 'off',
			'semi': 'off',
			'no-mixed-spaces-and-tabs': 'error',
			'no-trailing-spaces': 'error',
			'@typescript-eslint/consistent-type-definitions': 'off',
			'@typescript-eslint/dot-notation': 'off',
			'@typescript-eslint/explicit-member-accessibility': [
				'off',
				{
					accessibility: 'explicit',
				},
			],
			'@typescript-eslint/no-use-before-define': 'off',
			'@typescript-eslint/no-shadow': 'off',
			'@typescript-eslint/member-ordering': ['error', { default: ['field', 'public-constructor', 'constructor', 'method'] }],
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-empty-function': ['error', { allow: ['private-constructors'] }],
			'brace-style': ['error', '1tbs', { allowSingleLine: true }],
			'id-denylist': 'off',
			'id-match': 'off',
			'max-len': [
				'error',
				{
					ignorePattern: '^import |^export \\{(.*?)\\}|^\\s*@inject\\(',
					code: 150,
				},
			],
			'@typescript-eslint/naming-convention': [
				'error',
				{
					selector: 'default',
					format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
					leadingUnderscore: 'allow',
				},
				{
					selector: 'objectLiteralProperty',
					format: null,
				},
				{
					selector: ['property', 'parameter'],
					format: null,
					filter: {
						regex: '(filter_single)|(_.*)|(@.*)|(<.*)|(\\+=)',
						match: true,
					},
				},
			],
			'no-underscore-dangle': 'off',
			'@angular-eslint/no-inputs-metadata-property': 'error',
			'@angular-eslint/no-outputs-metadata-property': 'error',
			'@angular-eslint/use-lifecycle-interface': 'error',
			'arrow-parens': ['error', 'as-needed'],
			'comma-dangle': ['error', 'always-multiline'],
			'prefer-arrow/prefer-arrow-functions': ['error', { allowStandaloneDeclarations: true }],
		},
	},
	{
		files: ['**/*.html'],
		languageOptions: {
			parser: angularTemplateParser,
		},
		plugins: {
			'@angular-eslint/template': angularTemplate,
		},
		rules: {
			...angularTemplate.configs.recommended.rules,
			'max-len': ['error', 150],
		},
	},
	{
		files: ['**/*.test.ts', '**/*.spec.ts'],
		rules: {
			'no-unused-expressions': 'off',
			'@typescript-eslint/no-unused-expressions': 'off',
		},
	},
	prettier,
]
