import { readdirSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const GRAMMAR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/tree-sitter-wasms/out");

console.log(readdirSync(GRAMMAR_DIR));

export const TREE_SITTER_PARSERS = {
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  ruby: 'tree-sitter-ruby',
  java: 'tree-sitter-java',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  csharp: 'tree-sitter-csharp',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
};
