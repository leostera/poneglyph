// Slim Monaco entry: every editor feature (suggest, hover, find, folding,
// codicons…) plus TypeScript only, instead of editor.main's 80+ languages.
import "monaco-editor/features/register.all.js";
import "monaco-editor/languages/definitions/typescript/register.js";
export * from "monaco-editor/editor/editor.api.js";
export { typescriptDefaults } from "monaco-editor/languages/features/typescript/register.js";
