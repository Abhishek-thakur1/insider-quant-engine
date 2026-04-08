import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: "latest",
            sourceType: "module", s
        },
        plugins: {
            "@typescript-eslint": tsPlugin,
        },
        rules: {
            "no-console": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
            "semi": ["error", "always"],
        },
    },
];