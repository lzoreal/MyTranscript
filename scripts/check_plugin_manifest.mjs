/* 插件清单校验器：不启动宿主、不看插件脚本，只按公共契约检查 plugin.json。
   用法：
     node scripts/check_plugin_manifest.mjs <插件目录或 plugin.json> [...]
     node scripts/check_plugin_manifest.mjs --set <目录...>     # 按一个插件集合校验依赖/顺序
     node scripts/check_plugin_manifest.mjs --legacy <路径>     # 2.0 旧清单走兼容校验
     node scripts/check_plugin_manifest.mjs --json <路径>       # 机器可读输出
   退出码：0 全部通过；1 有错误；2 路径/JSON 读不出来。 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest, validatePluginSet, HOST_API_VERSION } from '../src/player-js/host/contract.js';
import { validateLegacyManifest } from '../src/player-js/host/legacy.js';

function usage() {
  return [
    '用法：node scripts/check_plugin_manifest.mjs [--set] [--legacy] [--json] <插件目录或 plugin.json> ...',
    '  --set     把多个插件当成一个集合，检查依赖版本与加载顺序',
    '  --legacy  按 2.0 旧清单兼容规则校验（缺 contributions / requires 数组）',
    '  --json    输出 JSON 报告',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { set: false, legacy: false, json: false, paths: [] };
  for (const arg of argv) {
    if (arg === '--set') options.set = true;
    else if (arg === '--legacy') options.legacy = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error('未知参数：' + arg);
    else options.paths.push(arg);
  }
  return options;
}

function manifestPath(input) {
  const path = String(input);
  if (statSync(path).isDirectory()) return join(path, 'plugin.json');
  return path;
}

function readManifest(input) {
  const path = manifestPath(input);
  const text = readFileSync(path, 'utf8');
  return { path, manifest: JSON.parse(text) };
}

function summarize(id, version, contributions) {
  const total = Object.values(contributions || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  return 'OK ' + id + (version ? '@' + version : '') + ' · ' + total + ' 个贡献点';
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    console.error(usage());
    return 2;
  }
  if (options.help || !options.paths.length) {
    console.log(usage());
    return options.help ? 0 : 2;
  }
  const loaded = [];
  for (const path of options.paths) {
    try {
      loaded.push(readManifest(path));
    } catch (err) {
      console.error('读取失败：' + path + ' · ' + (err.message || err));
      return 2;
    }
  }
  const result = options.set
    ? validatePluginSet(loaded.map(item => item.manifest), { strict: !options.legacy })
    : null;
  const reports = options.set ? [] : loaded.map(item => ({
    path: item.path,
    manifest: item.manifest,
    report: options.legacy ? validateLegacyManifest(item.manifest) : validateManifest(item.manifest),
  }));
  const report = options.set
    ? {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      order: result.order,
      plugins: [...result.plugins.keys()],
    }
    : {
      ok: reports.every(item => item.report.ok),
      errors: reports.flatMap(item => item.report.errors.map(err => ({ ...err, path: item.path }))),
      warnings: reports.flatMap(item => item.report.warnings.map(warn => ({ ...warn, path: item.path }))),
    };
  if (options.json) {
    console.log(JSON.stringify({ hostVersion: HOST_API_VERSION, ...report }, null, 2));
  } else {
    report.warnings.forEach(warn => console.warn('WARN ' + (warn.pluginId ? warn.pluginId + ' ' : '') + warn.message));
    report.errors.forEach(err => console.error('ERR ' + (err.pluginId ? err.pluginId + ' ' : '') + err.message));
    if (report.ok) {
      if (options.set) {
        loaded.forEach(item => console.log(summarize(item.manifest.id, item.manifest.version, item.manifest.contributions)));
        console.log('加载顺序：' + report.order.join(' → '));
      } else {
        reports.forEach(item => console.log(summarize(item.report.manifest?.id, item.report.manifest?.version,
          item.report.manifest?.contributions)));
      }
    } else {
      console.error('清单校验失败：' + report.errors.length + ' 个错误');
    }
  }
  return report.ok ? 0 : 1;
}

process.exitCode = main();
