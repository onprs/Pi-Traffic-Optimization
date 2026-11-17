// 原生 ESM 保留 URL 的版本参数，使 Pi reload 可加载新的模块图。
export const loadNativeModule = url => import(url);
