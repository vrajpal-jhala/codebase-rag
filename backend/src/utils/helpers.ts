import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { File } from '../types';
import ignore, { type Ignore } from 'ignore';

export const walk = async (dir: string) => {
  const rootDir = resolve(dir);
  const files: File[] = [];

  const recurse = async (currentDir: string, depth: number = 0, gitignore: Ignore | null = null) => {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const path = join(entry.parentPath, entry.name).replace(/\\/g, '/');
      const relativePath = relative(currentDir, path).replace(/\\/g, '/');
      const isDirectory = entry.isDirectory();
      const gitignorePath = join(path, '.gitignore');

      if (depth === 0 && await Bun.file(gitignorePath).exists()) {
        gitignore = ignore().add(await Bun.file(gitignorePath).text());
      }

      if (gitignore?.ignores(relativePath) || entry.name.startsWith('.')) {
        continue;
      }

      if (isDirectory) {
        await recurse(path, depth + 1, gitignore);
      }

      files.push({
        path,
        relativePath,
        isDirectory,
        depth,
      });
    }
  };

  await recurse(rootDir);

  return files;
};
