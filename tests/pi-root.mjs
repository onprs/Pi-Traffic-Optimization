import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// 查找顺序：显式指定、项目 devDependencies、全局 npm 安装。
export function piRoot() {
  if (process.env.PI_TRAFFIC_OPT_PI_ROOT) return resolve(process.env.PI_TRAFFIC_OPT_PI_ROOT);
  const candidates = [
    resolve(import.meta.dirname, '../node_modules/@earendil-works/pi-coding-agent'),
    process.env.APPDATA && join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent'),
    join(dirname(dirname(process.execPath)), 'lib/node_modules/@earendil-works/pi-coding-agent'),
  ].filter(Boolean);
  return candidates.find(path => existsSync(join(path, 'package.json'))) ?? candidates[0];
}
