// 发布前校验并输出发布说明。
// 用法：node scripts/release-notes.mjs [tag]
// 校验 tag 与 package.json 版本一致、CHANGELOG.md 存在对应版本段落，然后把该段落输出到 stdout。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = process.argv[2];
const fail = message => { console.error(message); process.exit(1); };

if (tag && tag !== `v${version}`) fail(`tag ${tag} 与 package.json 版本 v${version} 不一致`);

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const heading = /^## \[?(\d+\.\d+\.\d+[^\]\s]*)\]?/;
const start = lines.findIndex(line => heading.exec(line)?.[1] === version);
if (start < 0) fail(`CHANGELOG.md 缺少 ${version} 的版本段落`);
const end = lines.findIndex((line, index) => index > start && heading.test(line));
const notes = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
if (!notes) fail(`CHANGELOG.md 中 ${version} 的版本段落为空`);
process.stdout.write(notes + '\n');
