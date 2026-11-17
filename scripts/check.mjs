// 语法检查：逐个文件执行 node --check，Windows 与 Ubuntu 行为一致。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const extensions = ['.mjs', '.ts'];
const files = ['src', 'tests', 'scripts'].flatMap(directory =>
  readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && extensions.some(extension => entry.name.endsWith(extension)))
    .map(entry => join(entry.parentPath, entry.name)));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(`${relative(root, file)}\n${result.stderr}\n`);
  }
}
console.log(`语法检查：${files.length - failed}/${files.length} 通过`);
process.exit(failed ? 1 : 0);
