/* 旧插件清单适配：现有插件用 `requires: [...]`、没有 `contributions`、也没有
   `apiVersion`；v2 契约要求对象依赖和贡献点。这里只做归一化，不改变旧宿主的
   注册路径，让现有插件能先过新契约校验。 */
import { validateManifest } from './contract.js';

export function normalizeLegacyManifest(input) {
  const source = input && typeof input === 'object' ? input : {};
  const legacyRequires = Array.isArray(source.requires) ? [...source.requires] : null;
  const requires = legacyRequires
    ? Object.fromEntries(legacyRequires.map(id => [String(id), '*']))
    : (source.requires && typeof source.requires === 'object' ? { ...source.requires } : {});
  const contributions = source.contributions && typeof source.contributions === 'object'
    ? source.contributions
    : {};
  const manifest = {
    ...source,
    apiVersion: source.apiVersion || '2.0',
    requires,
    contributions,
    legacy: true,
    legacyRequires,
  };
  // Rust 视图在“清单没声明 permissions”时回传 null，不能当成非法数组。
  if (source.permissions === null || source.permissions === undefined) delete manifest.permissions;
  return manifest;
}

/* 旧清单按非严格模式校验：允许没有 contributions / apiVersion，也允许
   `requires` 数组；但 id、路径、未知权限、未知槽位仍然拒绝。 */
export function validateLegacyManifest(input, options = {}) {
  const manifest = normalizeLegacyManifest(input);
  const report = validateManifest(manifest, { strict: false, ...options });
  return {
    ...report,
    manifest: report.manifest ? { ...report.manifest, legacy: true, legacyRequires: manifest.legacyRequires } : null,
    legacy: true,
  };
}
