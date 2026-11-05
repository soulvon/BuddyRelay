#!/usr/bin/env node
/**
 * 模型级 429 被动记录：重置时刻解析与宿主日志行解析的回归断言。
 * 只跑纯函数，不发网络请求；依赖 compile 生成的 out/ 产物。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mc = require(path.join(ROOT, 'out', 'cooldownLogWatcher.js'));

let failed = 0;
let passed = 0;
function gate(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function mustThrow(fn) {
  try {
    fn();
    return false;
  } catch (_) {
    return true;
  }
}

const msg = '您的使用量已超出频率限制，将在 2026-11-05 22:48:00 UTC+8 重置，您也可以切换其他模型继续使用。';
gate('UTC+8 重置时刻换算', mc.parseResetAt(msg) === Date.UTC(2026, 10, 5, 14, 48, 0));
gate('UTC+0 重置时刻换算', mc.parseResetAt('将在 2026-11-05 22:48:00 UTC+0 重置') === Date.UTC(2026, 10, 5, 22, 48, 0));
gate('UTC-5 重置时刻换算', mc.parseResetAt('将在 2026-11-05 22:48:00 UTC-5 重置') === Date.UTC(2026, 10, 6, 3, 48, 0));
gate('缺重置时刻必须抛错而非猜测冷却', mustThrow(() => mc.parseResetAt('rate limited, no reset time')));

const LOG_LINE = '2026-11-05 17:06:45.940 [error] [ResultHandler.handleError] errorMessage ' +
  JSON.stringify({
    requestId: 'req-1',
    createTime: 1793869605940,
    error: {
      code: 6004,
      message: msg,
      requestId: 'req-1',
      traceId: 'trace-1',
      model: 'deepseek-v4.1-flash'
    }
  });
const parsed = mc.parseErrorLine(LOG_LINE);
gate('日志行解析出限流码', parsed && parsed.code === 6004, JSON.stringify(parsed));
gate('日志行解析出模型 ID', parsed && parsed.model === 'deepseek-v4.1-flash', JSON.stringify(parsed));
gate('日志行解析出 requestId 与撞限时间',
  parsed && parsed.requestId === 'req-1' && parsed.hitAt === 1793869605940, JSON.stringify(parsed));
gate('非目标日志行返回 null', mc.parseErrorLine('2026-11-05 17:06:46.364 [info] [MsgCenter] GET summary status=200') === null);
gate('errorMessage 损坏必须抛错而非静默跳过', mustThrow(() =>
  mc.parseErrorLine('2026-11-05 17:06:45.940 [error] [ResultHandler.handleError] errorMessage {"error":')));

// 2026-11-05 死循环事故回归：genie 会话会把聊天内容（含日志示例文本）原样写进日志，
// 旧行内子串匹配把对话复述行误判成 429 事件，解析抛错未隔离导致扩展宿主反复崩溃。
const pollutedStream = '2026-11-05 19:30:00.000 [info] [StreamParser] 参数解析完成: chatcmpl-x - 参数: arguments - 值: ' +
  '{"command":"copyText","text":"[error] [ResultHandler.handleError] errorMessage {\\"code\\":6004,\\"model\\":\\"x\\"}"}';
gate('对话工具参数里复述的日志示例不得误判（旧版在此崩溃）', mc.parseErrorLine(pollutedStream) === null);
const pollutedMd = '- **上游 429 协议分析：** 宿主在聊天遭遇 429 时会写入 [error] [ResultHandler.handleError] errorMessage ' +
  '{"error":{"code":6004,"message":"将在 2026-11-05 22:48:00 UTC+8 重置","model":"deepseek-v4.1-flash"}}';
gate('会话 markdown 复述行不得误判', mc.parseErrorLine(pollutedMd) === null);
const pollutedLevel = '2026-11-05 19:30:00.000 [info] [ResultHandler.handleError] errorMessage {"error":{"code":6004,"message":"将在 2026-11-05 22:48:00 UTC+8 重置","model":"x"}}';
gate('非 [error] 级别的同构行不得误判', mc.parseErrorLine(pollutedLevel) === null);

const UID = '883ad9d4-211e-4214-afeb-4d123d11b0f4';
gate('从 identity 行提取账号 uid', mc.extractUid(`identity={"uid":"${UID}","tenant_id":"personal"}`) === UID);
gate('从 currentUid 行提取账号 uid', mc.extractUid(`Pushing config to all targets, currentUid: ${UID}, instance: snzg2n`) === UID);
gate('无账号信息的行返回空串', mc.extractUid('[info] [MsgCenter] status=200') === '');

console.log(`\n模型冷却被动解析测试: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
