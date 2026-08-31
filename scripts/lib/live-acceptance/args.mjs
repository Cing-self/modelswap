// Argument parsing and mode-specific safety validation for the provider
// live-acceptance tool. Pure: the offline tests drive every rejection rule
// through this module.

import {
  MODES, DEFAULT_PROFILE_BY_MODE, findUnsafeArg, isSimpleProfileName,
} from './safety.mjs';

export const USAGE = [
  '用法：node scripts/provider-live-acceptance.mjs --mode <guest|auth-verify|create-cleanup> [选项]',
  '',
  '  --mode <m>              guest=全新临时会话验证登录墙；auth-verify=专用已登录 profile 验证安全入口；create-cleanup=单平台真实创建+清理（默认禁止）',
  '  --platform <id>         平台 ID，可重复或逗号分隔（--list 查看全部）。guest/auth-verify 省略时默认全部 browser 平台；create-cleanup 必须恰好一个',
  '  --dry-run               只生成计划与报告格式，不启动浏览器、不访问任何外部资源',
  '  --allow-create-and-cleanup  create-cleanup 的危险确认开关（注意：真实创建当前被硬禁用，仅 dry-run 可用；解禁条件见 docs/testing/provider-live-acceptance.md）',
  '  --session <id>          create-cleanup 真实运行必需：provider-live-chrome --with-extension 生成的一次性验收会话标识（用于证明扩展连接来自专用 Chrome）',
  '  --profile <name>        专用 profile 名（仅 auth-verify；纯标识符，不是路径）',
  '  --screenshots <p>       off | login-only | all（默认 guest=all，auth-verify=login-only，create-cleanup=off）',
  '  --keep-open             运行后保留专用 Chrome（auth-verify 默认保留，便于人工登录）',
  '  --chrome-bin <path>     显式指定 Chrome/Chromium/Edge 可执行文件',
  '  --debug-port <port>     专用 Chrome 的 CDP 调试端口（默认 9333）',
  '  --list                  列出全部平台后退出',
  '',
  '安全边界：绝不复用/复制/导出日常 Chrome 的任何数据；产物只写入 ~/.okit/provider-live-acceptance/。',
].join('\n');

export const SCREENSHOT_POLICIES = ['off', 'login-only', 'all'];

function splitPlatforms(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseLiveAcceptanceArgs(argv) {
  const tokens = Array.isArray(argv) ? argv : [];
  const parsed = {
    mode: '',
    platforms: [],
    dryRun: false,
    allowCreateAndCleanup: false,
    profileName: '',
    session: '',
    withExtension: false,
    keepOpen: null,
    screenshots: '',
    chromeBin: '',
    debugPort: 0,
    list: false,
  };
  const fail = (error) => ({ ok: false, error });

  const unsafe = findUnsafeArg(tokens);
  if (unsafe) {
    return fail(`拒绝不安全参数 ${unsafe}：验收工具绝不读取、复制、迁移或导出日常浏览器的任何数据`);
  }

  const takeValue = (tokens, index, flag) => {
    const value = tokens[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error(`${flag} 需要一个值`);
    }
    return value;
  };

  try {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      let consumedValue = false;
      const valueOf = (flag) => { consumedValue = true; return takeValue(tokens, index, flag); };
      if (token === '--list') parsed.list = true;
      else if (token === '--dry-run') parsed.dryRun = true;
      else if (token === '--allow-create-and-cleanup') parsed.allowCreateAndCleanup = true;
      else if (token === '--session') parsed.session = valueOf('--session');
      else if (token.startsWith('--session=')) parsed.session = token.slice('--session='.length);
      else if (token === '--keep-open') parsed.keepOpen = true;
      else if (token === '--mode') parsed.mode = valueOf('--mode');
      else if (token.startsWith('--mode=')) parsed.mode = token.slice('--mode='.length);
      else if (token === '--platform') parsed.platforms.push(...splitPlatforms(valueOf('--platform')));
      else if (token.startsWith('--platform=')) parsed.platforms.push(...splitPlatforms(token.slice('--platform='.length)));
      else if (token === '--profile') parsed.profileName = valueOf('--profile');
      else if (token.startsWith('--profile=')) parsed.profileName = token.slice('--profile='.length);
      else if (token === '--screenshots') parsed.screenshots = valueOf('--screenshots');
      else if (token.startsWith('--screenshots=')) parsed.screenshots = token.slice('--screenshots='.length);
      else if (token === '--chrome-bin') parsed.chromeBin = valueOf('--chrome-bin');
      else if (token.startsWith('--chrome-bin=')) parsed.chromeBin = token.slice('--chrome-bin='.length);
      else if (token === '--debug-port') parsed.debugPort = Number(valueOf('--debug-port'));
      else if (token.startsWith('--debug-port=')) parsed.debugPort = Number(token.slice('--debug-port='.length));
      else return fail(`未知参数：${token}\n${USAGE}`);
      if (consumedValue) index += 1;
    }
  } catch (error) {
    return fail(`${error.message}\n${USAGE}`);
  }

  // --list mirrors the old checker: it is always safe and needs no --mode.
  if (parsed.list) return { ok: true, ...parsed, effective: null };

  if (parsed.mode === '') return fail(`缺少 --mode（guest | auth-verify | create-cleanup）\n${USAGE}`);
  if (!MODES.includes(parsed.mode)) return fail(`未知模式：${parsed.mode}\n${USAGE}`);
  if (parsed.screenshots !== '' && !SCREENSHOT_POLICIES.includes(parsed.screenshots)) {
    return fail(`--screenshots 仅支持 ${SCREENSHOT_POLICIES.join(' | ')}\n${USAGE}`);
  }
  if (parsed.debugPort !== 0 && (!Number.isInteger(parsed.debugPort) || parsed.debugPort < 1024 || parsed.debugPort > 65535)) {
    return fail('--debug-port 需要在 1024–65535 之间的整数\n' + USAGE);
  }

  if (parsed.profileName !== '' && !isSimpleProfileName(parsed.profileName)) {
    return fail('--profile 只接受简单标识符（字母/数字/./_/-，且不是路径）；如需隔离请使用不同名称，验收 profile 永远位于 ~/.okit/provider-live-acceptance/ 内');
  }

  if (parsed.session !== '' && !/^[A-Za-z0-9-]{8,64}$/.test(parsed.session)) {
    return fail('--session 只接受 provider-live-chrome --with-extension 输出的一次性会话标识（8-64 位字母/数字/连字符）');
  }

  if (parsed.mode === 'guest' && parsed.profileName !== '') {
    return fail('guest 模式每次使用全新临时用户目录，不支持 --profile');
  }

  if (parsed.mode === 'create-cleanup') {
    if (parsed.platforms.length === 0) {
      return fail('create-cleanup 必须用 --platform 明确指定唯一平台；不接受隐式批量');
    }
    if (parsed.platforms.length > 1) {
      return fail(`create-cleanup 一次只允许一个平台（收到 ${parsed.platforms.length} 个：${parsed.platforms.join(', ')}）`);
    }
    if (!parsed.dryRun && !parsed.allowCreateAndCleanup) {
      return fail('create-cleanup 默认禁止：真实运行必须同时给出 --platform 与 --allow-create-and-cleanup（会真实创建并删除第三方密钥）');
    }
    if (!parsed.dryRun && parsed.session === '') {
      return fail('create-cleanup 真实运行需要 --session <id>：由 provider-live-chrome --with-extension 生成的一次性验收会话；无法证明扩展连接来自专用 Chrome 时一律拒绝');
    }
  }

  const effective = {
    profileName: parsed.profileName || DEFAULT_PROFILE_BY_MODE[parsed.mode] || '',
    keepOpen: parsed.keepOpen !== null ? parsed.keepOpen : parsed.mode === 'auth-verify',
    screenshots: parsed.screenshots
      || (parsed.mode === 'guest' ? 'all' : parsed.mode === 'auth-verify' ? 'login-only' : 'off'),
  };

  return { ok: true, ...parsed, effective };
}
