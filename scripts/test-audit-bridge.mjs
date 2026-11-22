import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
await test('closed-agent session is not reused after switching to chat', async (h) => {
  h.setMode('closed-agent');
  const privileged = await h.ensureSession('private:123');
  h.setMode('chat');
  const restricted = await h.ensureSession('private:123');
  assert.notEqual(restricted, privileged);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat');
  assert.ok(h.calls.cancelled.includes(privileged));
});
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing', { strict: true }), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('session creation crossing a mode change never accepts stale permissions', async (h) => {
  h.setMode('closed-agent');
  let release;
  const original = h.api.sessions.create;
  h.api.sessions.create = async (params) => {
    const result = await original(params);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const pending = h.ensureSession('private:123');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.setMode('chat');
  release();
  await assert.rejects(pending);
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('queued send rechecks allowlist at actual transport time', async (h) => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});
await test('old prompt completion cannot delete replacement queue after reset', async (h) => {
  const release = [];
  h.api.sessions.prompt = async () => {
    await new Promise((resolve) => release.push(resolve));
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'first');
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  h.drainPromptQueue('group:456', 'reset');
  const second = h.deliverPrompt('group:456', 'second');
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const replacement = h.promptQueues.get('group:456');
  release[0](); await first;
  assert.equal(h.promptQueues.get('group:456'), replacement);
  release[1](); await second;
});
await test('same-policy sessions are reused but legacy unlabelled sessions are replaced', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  delete h.state.sessionPolicies['private:123'];
  assert.notEqual(await h.ensureSession('private:123'), first);
});
await test('reset during model selection cannot return a detached session', async (h) => {
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ // 控制台重置路径必须与 retireSession 一样：清掉权限元数据并终止 DSH 侧排队的工作。
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = await h.ensureSession('private:123');
    assert.ok(h.state.sessionPolicies['private:123'], 'policy should exist before reset');
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    // 先模拟 SDK 已连上：表情同步在「WS 未连接」时会直接走 HTTP 兜底，
    // 而这里覆盖的 fetch 只服务发消息，不返回收藏表情数组。
    h.bot.emit('open');
    await h.sendStickerV2('group:456', 'fixture-sticker');
    assert.equal(body.message.find((part) => part.type === 'image').data.file, 'base64://' + image.toString('base64'));
    console.log('PASS sticker sending gives OneBot validated bytes, never a URL to refetch');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// ── 语音发送（AI 通道）的安全边界 ────────────────────────────────────────────
// 语音比文本更"重"（真的会说话、不可撤回），所以这里逐条钉住它的闸门：
// 来源只能是语音库、白名单必须命中、限流要生效、文件名审计要拦住本机路径。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  // 默认出厂配置是 voice.enabled=false（AI 不能发语音）；这里显式打开，
  // 才能测"打开之后"的各项闸门。关闭时的行为单独在下面钉一条。
  const voiceOn = { socialV2: { voice: { enabled: true } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    // 语音库 fixture：临时 config 的 ROOT 之下，voice.dir 默认 'audio'
    const audioDir = path.join(h.temp, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.alloc(1024, 1));
    // 库外的文件（模拟"随便一个本地文件"）
    const outside = path.join(h.temp, 'outside-secret.mp3');
    fs.writeFileSync(outside, Buffer.alloc(1024, 1));

    const names = h.voiceLibrary().map((v) => v.name);
    assert.ok(names.includes('hello.mp3'), '语音库列出库内音频');
    assert.ok(!names.some((n) => n.includes(h.temp)), '语音库不返回绝对路径');

    // 1) AI 只能按语音库名字取文件
    const okPath = h.resolveVoicePathForV2('hello');
    assert.equal(okPath.path, path.join(audioDir, 'hello.mp3'), 'AI 省略扩展名也能命中语音库文件');

    // 2) 绝对路径默认被拒（防 prompt injection 拿任意本地文件外发）
    assert.throws(() => h.resolveVoicePathForV2(outside), /语音库|绝对路径/, 'AI 传库外绝对路径被拒');
    assert.throws(() => h.resolveVoicePathForV2('C:\\Windows\\Media\\Alarm01.wav'), /语音库|绝对路径/, 'AI 传系统绝对路径被拒');

    // 3) 远程/内联来源被拒（体积与来源都不可控）
    for (const bad of ['https://example.com/a.mp3', 'base64://AAAA', 'data:audio/mp3;base64,AAAA']) {
      assert.throws(() => h.resolveVoicePathForV2(bad), /不接受|只能/, `AI 传 ${bad.split(':')[0]} 来源被拒`);
    }

    // 4) 真发一条（虚拟网关）：必须是 record 段、且 file 携带库内文件的字节。
    //    NapCat 跑在 Docker 容器里、看不到宿主机文件系统：bridge 已改为把音频内容
    //    用 base64:// 传给网关（见 src/bridge.js sendVoiceV2 的 recordFile），绝对
    //    路径反而会被容器当 URL 解析而失败。两种形态都合法，但内容必须与库内文件
    //    逐字节一致，不能是别的文件。
    const sent = await h.sendVoiceForV2('group:456', 'hello.mp3', { readback: false });
    const call = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
    assert.ok(call, '语音走 send_group_msg');
    assert.equal(call.body.group_id, 456, '语音发给正确群');
    assert.equal(call.body.message.length, 1, '语音只发一个段');
    assert.equal(call.body.message[0].type, 'record', '段类型是 record');
    const recordFile = call.body.message[0].data.file;
    const libraryBytes = fs.readFileSync(path.join(audioDir, 'hello.mp3')).toString('hex');
    if (recordFile.startsWith('base64://')) {
      const decoded = Buffer.from(recordFile.slice('base64://'.length), 'base64').toString('hex');
      assert.equal(decoded, libraryBytes, 'record 段 base64 内容与库内文件逐字节一致');
    } else {
      assert.equal(recordFile, path.join(audioDir, 'hello.mp3'), 'record 段指向库内绝对路径');
    }
    assert.equal(sent.messageId, 9001, '返回网关 message_id');
    assert.equal(sent.readback, null, '显式关掉回读时不调 fetch_ptt_text');

    // 5) 落地校验：默认用 get_msg 回读确认这条消息真的带 record 段
    const h2 = await bridgeHarness({ config: voiceOn });
    try {
      const dir2 = path.join(h2.temp, 'audio');
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir2, 'hi.mp3'), Buffer.alloc(512, 1));
      const sent2 = await h2.sendVoiceForV2('group:456', 'hi.mp3');
      // 注意：这些对象来自 vm realm，deepEqual 会因原型不同而失败 → 逐字段断言
      assert.equal(sent2.verification?.confirmed, true, '默认回读 get_msg 确认 record 段');
      assert.equal(sent2.verification?.duration, 3, '回读到语音时长');
      // 校验结果**不能**把源文件路径回传给 AI（私聊 get_msg 会把本机路径塞进 record.url）
      assert.equal(sent2.verification?.file, undefined, '校验结果不回传文件路径（防路径泄露进模型上下文）');
      assert.ok(h2.calls.http.some((c) => c.url.endsWith('/get_msg')), '校验走 get_msg');
      assert.equal(sent2.readback, null, '默认不索取转写（自己发的语音没有转写）');
      // 关掉校验时不发 get_msg
      const h2b = await bridgeHarness({ config: voiceOn });
      try {
        const dir2b = path.join(h2b.temp, 'audio');
        fs.mkdirSync(dir2b, { recursive: true });
        fs.writeFileSync(path.join(dir2b, 'hi.mp3'), Buffer.alloc(512, 1));
        const sent2b = await h2b.sendVoiceForV2('group:456', 'hi.mp3', { verify: false });
        assert.equal(sent2b.verification, null, 'verify=false 时不做回读校验');
        assert.ok(!h2b.calls.http.some((c) => c.url.endsWith('/get_msg')), 'verify=false 时不发 get_msg');
      } finally { await h2b.close(); }
    } finally { await h2.close(); }

    // 6) 文件名审计：含本机路径特征的名字不许外发。
    //    resolveVoicePathForV2 允许绝对路径的"文件名形态"由 allowAbsolutePath 管；
    //    这里直接喂一个**看起来就像本机路径**的名字，验证审计层会拦下来。
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', 'C:\\Users\\somebody\\secret-voice.mp3', { readback: false }),
      /敏感信息|语音库|绝对路径/,
      '文件名含本机路径特征被审计/来源校验拦截'
    );

    // 7) 限流：语音额度独立计数，超限拒绝
    const h3 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
    try {
      const dir3 = path.join(h3.temp, 'audio');
      fs.mkdirSync(dir3, { recursive: true });
      fs.writeFileSync(path.join(dir3, 'a.mp3'), Buffer.alloc(512, 1));
      await h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
      await assert.rejects(
        () => h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false }),
        /频率超限|每分钟/,
        '同一分钟内第二条语音被限流（每分钟 1 条）'
      );
      // 额度只在发出后才记账：参数错误不应吃掉配额
      const h4 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
      try {
        const dir4 = path.join(h4.temp, 'audio');
        fs.mkdirSync(dir4, { recursive: true });
        fs.writeFileSync(path.join(dir4, 'a.mp3'), Buffer.alloc(512, 1));
        await assert.rejects(() => h4.sendVoiceForV2('group:456', 'nope.mp3'), /找不到/, '不存在的音频被拒');
        // 失败没有消耗额度 → 紧接着真发一条应当成功
        const ok2 = await h4.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
        assert.equal(ok2.messageId, 9001, '失败不吃额度：随后发送成功');
      } finally { await h4.close(); }
    } finally { await h3.close(); }

    // 8) 语音功能总开关关闭时，**AI 通道**彻底拒绝
    const h5 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      await assert.rejects(() => h5.sendVoiceForV2('group:456', 'a.mp3'), /已关闭/, 'voice.enabled=false 时 AI 通道拒绝发送');
    } finally { await h5.close(); }

    // 9) 但**操作者通道**不受这个开关影响：否则"默认不启用"会变成"连手动试发都做不了"
    const h6 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      const dir6 = path.join(h6.temp, 'audio');
      fs.mkdirSync(dir6, { recursive: true });
      fs.writeFileSync(path.join(dir6, 'a.mp3'), Buffer.alloc(512, 1));
      const sent6 = await h6.sendVoiceV2('group:456', path.join(dir6, 'a.mp3'), { guard: false, audit: true });
      assert.equal(sent6.messageId, 9001, 'voice.enabled=false 时操作者仍能发（AI 开关不该封死手动路径）');
    } finally { await h6.close(); }

    // 10) 音量：倍数会传给音频处理，并原样回报给调用方
    const h7 = await bridgeHarness({ config: voiceOn });
    try {
      const dir7 = path.join(h7.temp, 'audio');
      fs.mkdirSync(dir7, { recursive: true });
      fs.writeFileSync(path.join(dir7, 'a.mp3'), Buffer.alloc(512, 1));
      const loud = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { volume: 2.5 } });
      assert.equal(loud.volume, 2.5, '音量倍数透传到音频处理');
      assert.equal(loud.audioMode, 'volume', 'mode 标为 volume');
      assert.match(loud.audioProcessing, /250%/, '处理说明含百分比');
      const normal = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true });
      assert.equal(normal.audioMode, 'original', '不传音量时保持原样（不转码）');
      assert.equal(normal.audioProcessing, '原始音量', '原样时说明为"原始音量"');
      const smart = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { normalize: true, loudness: 'loud' } });
      assert.equal(smart.audioMode, 'loudnorm', '智能音量 mode=loudnorm');
      assert.match(smart.audioProcessing, /-13/, '智能音量按档位给出目标 LUFS');
      // 非法音量必须被拦下（而不是把奇怪的值丢给 ffmpeg）
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { volume: 99 } }),
        /0\.1~4/,
        '越界音量被拒'
      );
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { normalize: true, loudness: 'nope' } }),
        /未知的响度档位/,
        '未知响度档位被拒'
      );
    } finally { await h7.close(); }

    console.log('PASS voice sending enforces library-only source, whitelist, budget, name audit and volume');
  } catch (error) { failures++; console.error('FAIL voice sending guards:', error.message); }
  finally { await h.close(); }
}

// ── 语音路径：allowAbsolutePath 不再放宽 AI 通道（任意本机音频外发）────────────
// 审计发现：开关打开时 resolveVoicePathForV2 会把 AI 给的绝对路径直接交给
// resolveAudioSource 解析，于是群友用提示注入就能让 AI 把本机任意音频（< 20MB）
// 发到群里；而 inspectAudio 在 ffprobe 不可用时对任何文件都放行。
// 现在即使开了开关，绝对路径也必须落在语音库目录之内。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, allowAbsolutePath: true, maxPerMinute: 50, maxPerHour: 50 } } } });
  try {
    const libraryDir = path.join(h.temp, 'audio');
    const outsideDir = path.join(h.temp, 'outside');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'inside.mp3'), Buffer.alloc(512, 1));
    const outsideFile = path.join(outsideDir, 'secret.mp3');
    fs.writeFileSync(outsideFile, Buffer.alloc(512, 2));

    // 库外的绝对路径必须被拒绝（即使 allowAbsolutePath=true）
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', outsideFile, { readback: false }),
      /语音库/,
      'allowAbsolutePath=true 时库外绝对路径仍必须被拒绝'
    );
    // 相对穿越同样必须被拒绝
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', path.join('..', 'outside', 'secret.mp3'), { readback: false }),
      /语音库|\.\./,
      '相对路径穿越必须被拒绝'
    );
    // 库内的绝对路径应当仍然可用（开关的合理用途）
    const inside = await h.sendVoiceForV2('group:456', path.join(libraryDir, 'inside.mp3'), { readback: false });
    assert.equal(inside.messageId, 9001, '库内绝对路径仍可发送');
    console.log('PASS voice absolute paths stay confined to the library even when allowAbsolutePath is on');
  } catch (error) { failures++; console.error('FAIL voice library confinement:', error.message); }
  finally { await h.close(); }
}

// agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
// 因此仅靠控制台令牌挡不住 QQ 群里的 AI。人格/提示词/思考强度/白名单/重启等管理端点
// 必须对 agent token 一律 403，否则 AI 能改写自己的系统提示词或给自己提权。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const adminOnly = { 'x-console-token': 'fixture-console-token' };
    const asAgent = { ...adminOnly, 'x-agent-token': 'fixture-agent-token' };
    const mustDeny = [
      ['GET', '/api/roles'], ['GET', '/api/roles/content?name=x'], ['GET', '/api/roles?x=1'],
      ['POST', '/api/roles/create'], ['POST', '/api/roles/update'],
      ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
      ['GET', '/api/preset/sim-prompt'], ['POST', '/api/preset/sim-prompt'],
      ['GET', '/api/preset/sim-prompt/backups'], ['POST', '/api/preset/sim-prompt/restore'],
      ['GET', '/api/dsh/model'], ['POST', '/api/dsh/effort'],
      ['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['POST', '/api/restart'],
      ['POST', '/api/console/token'], ['GET', '/api/role'], ['POST', '/api/role'],
    ];
    for (const [method, path] of mustDeny) {
      const res = await call(path, method, asAgent, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${method} ${path} 必须对 agent token 拒绝，实际 HTTP ${res.status}`);
    }
    // 绕过尝试：路径穿越与重复斜杠在 URL 解析后仍需被拒
    for (const path of ['/api/roles/../roles', '/api//roles', '/api/./roles', '/api/roles/']) {
      const res = await call(path, 'GET', asAgent);
      assert.notEqual(res.status, 200, `${path} 不得绕过 agent token 限制（实际 HTTP ${res.status}）`);
    }
    // 允许面：AI 真正需要的只读接口不应被误伤
    const allowed = await call('/api/status', 'GET', asAgent);
    assert.equal(allowed.status, 200, '/api/status 应对 agent token 放行');
    // 同一批管理端点，管理员（仅控制台令牌）应可正常访问
    const adminOk = await call('/api/dsh/model', 'GET', adminOnly);
    assert.equal(adminOk.status, 200, '管理员应能访问 /api/dsh/model');
    console.log('PASS agent token cannot reach persona/prompt/effort/whitelist admin endpoints');
  } catch (error) { failures++; console.error('FAIL agent token admin isolation:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// ── 控制台入口的传输层防护：Host 头 + 令牌定长比较 + /api/authorize/read 鉴权 ──
// 这三条都是「审计发现 → 加固」的结果，钉住它们以防以后被无意改回去。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const admin = { 'x-console-token': 'fixture-console-token' };

    // ① DNS rebinding 硬化：非本机 Host 一律拒绝（即使带着正确的控制台令牌）。
    // 注意 Host 必须走 headers（Node 会用 options.host 覆盖它，那样测不到伪造 Host）。
    for (const host of ['evil.example.com:' + port, '127.0.0.1:1', 'localhost']) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 403, `Host=${host} 必须被拒绝，实际 HTTP ${res.status}`);
    }
    // 合法的三个 Host 都要放行（127.0.0.1 / localhost / [::1] 加实际端口）
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 200, `Host=${host} 应被接受，实际 HTTP ${res.status}`);
    }

    // ② 令牌比较必须是定长：错长度/错内容的令牌都不得通过（不能因为"前缀对"就放行）。
    // 注意 Node 的 HTTP 客户端会自动裁掉自定义头的首尾空白，所以"带尾空格"这一类
    // 必须用 ?token= 传（控制台本来就接受这种入口，它才是真实的攻击面）。
    for (const token of ['fixture-console-token-x', 'fixture-console-toke', 'FIXTURE-CONSOLE-TOKEN', 'fixture-console-token ']) {
      const res = await call(`/api/status?token=${encodeURIComponent(token)}`, 'GET');
      assert.equal(res.status, 401, `令牌「${token}」不得通过鉴权，实际 HTTP ${res.status}`);
    }
    const noHeader = await call('/api/status', 'GET');
    assert.equal(noHeader.status, 401, '不带令牌必须被拒绝');

    // ③ /api/authorize/read 不再接受空令牌（它曾对 agent 流量开放 ⇒ 成为免鉴权入口）。
    const noToken = await call('/api/authorize/read', 'POST', { ...admin, 'x-agent-token': 'x' }, { key: 'group:456' });
    assert.equal(noToken.status, 403, '空会话令牌必须被拒绝');
    console.log('PASS console rejects foreign Host headers, non-exact tokens and token-less authorize/read');
  } catch (error) { failures++; console.error('FAIL console transport guards:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── 新能力接线：入站语音转写 / 视频摘要降级 / 按会话模型覆盖 ──
// 这些用例钉的是「bridge.js 里的接线」而不是纯函数本身（纯函数各有独立测试文件），
// 所以走真实入口：decorateInboundVoice 走 fetch 桩、digestInboundVideo 走 spawn 桩、
// ensureTurnModelFor 走 api.sessions.selectModel 桩。
await test('inbound voice is transcribed and replaces the [语音] placeholder', async (h) => {
  const before = h.calls.http.length;
  const out = await h.decorateInboundVoice({
    textContent: '在吗 [语音]',
    plainContent: '在吗 [语音]',
    mediaList: [{ kind: 'record', file: 'fixture.amr', duration: 3 }],
    segments: [{ type: 'record', data: { file: 'fixture.amr', duration: 3 } }],
    messageId: 4242,
    isSelf: false,
    cfg: h.cfg,
    key: 'private:123',
  });
  assert.match(out.textContent, /\[语音转写\] fixture-transcript/, '应把转写文本替换进 textContent');
  assert.match(out.plainContent, /\[语音转写\] fixture-transcript/, 'plainContent 也要替换（reserved2 用它入库）');
  const calls = h.calls.http.slice(before).filter((c) => c.url.endsWith('/fetch_ptt_text'));
  assert.equal(calls.length, 1, '每条语音只应请求一次 fetch_ptt_text');
  assert.deepEqual(calls[0].body, { message_id: '4242' });
});
await test('inbound voice respects disabled switch, self messages and existing notes', async (h) => {
  const voice = { kind: 'record', file: 'fixture.amr' };
  const base = {
    textContent: '[语音]', plainContent: '[语音]',
    mediaList: [voice], segments: [{ type: 'record', data: { file: 'fixture.amr' } }],
    messageId: 4243, isSelf: false, key: 'private:123',
  };
  const before = h.calls.http.length;
  // ① socialV2.voiceInbound.enabled=false：一次网络请求都不该发
  const off = { ...h.cfg, socialV2: { ...h.cfg.socialV2, voiceInbound: { enabled: false } } };
  let out = await h.decorateInboundVoice({ ...base, cfg: off });
  assert.equal(out.textContent, '[语音]');
  // ② 自己发的语音：QQ 侧没有转写，直接跳过
  out = await h.decorateInboundVoice({ ...base, cfg: h.cfg, isSelf: true });
  assert.equal(out.textContent, '[语音]');
  // ③ 已有注记：不重复请求
  out = await h.decorateInboundVoice({ ...base, cfg: h.cfg, textContent: '[语音转写] 早就转过了', plainContent: '[语音转写] 早就转过了' });
  assert.equal(out.textContent, '[语音转写] 早就转过了');
  const calls = h.calls.http.slice(before).filter((c) => c.url.endsWith('/fetch_ptt_text'));
  assert.equal(calls.length, 0, '关闭/自己发/已有注记都不应请求 fetch_ptt_text');
});
await test('video digest failures degrade to a placeholder instead of throwing', async (h) => {
  // harness 的 spawn 桩固定 exit 1，且 fetch 桩拿不到真实视频字节 ⇒ 必然走失败分支。
  const media = { kind: 'video', file: 'fixture.mp4', url: '', size: 1024 };
  const result = await h.digestInboundVideo(media, 'private:123');
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.error, 'string', '失败时必须返回 { error }，由调用方给占位文本');
  const parts = await h.resolveMediaList([media], 'private:123');
  assert.ok(Array.isArray(parts) && parts.length >= 1, '视频失败也要留下占位文字');
  assert.ok(parts.some((p) => p.type === 'text' && p.text.includes('[视频')), '占位文本要以 [视频 开头');
});
await test('video media keeps its kind and legacy image-video entries are migrated', async (h) => {
  // 2026-11-22 05:05 事故：mp4 被存储层拍平成 kind:'image'，于是 fitImage 去 get_image
  // （对视频必然失败），抽帧分支永远走不到 —— 用户侧就是「视频打不开」。
  await h.appendSocialV2Message(
    'private:100000001', '对方', '[视频]', '[视频]', false, false, 'fixture-video-1',
    [{ kind: 'video', file: 'clip.mp4', url: 'https://example.invalid/clip.mp4', name: 'clip.mp4', size: 4096, duration: 6 }],
    '100000001', [], ''
  );
  const st = h.getSocialV2State('private:100000001');
  const stored = [...(st.recentMessages || [])].reverse().find((m) => m.messageId === 'fixture-video-1');
  assert.ok(stored, '视频消息应已入库');
  assert.equal(stored.media[0].kind, 'video', '视频必须按 video 存，不能拍平成 image');
  assert.equal(stored.media[0].name, 'clip.mp4', '视频要保留文件名（抽帧缓存键要用）');
  assert.equal(stored.media[0].size, 4096, '视频要保留大小');

  // 旧数据迁移：文件名/URL 命中视频扩展名的 image 项改判 video，普通 jpg 不动。
  const legacy = {
    recentMessages: [
      { seq: 1, media: [{ kind: 'image', file: 'abc.mp4' }] },
      { seq: 2, media: [{ kind: 'image', url: 'https://example.invalid/a.JPG?x=1' }] }
    ],
    unread: [{ seq: 3, media: [{ kind: 'image', url: 'https://example.invalid/b.mov?rkey=1' }] }]
  };
  const changed = h.migrateVideoMediaKinds(legacy);
  assert.equal(changed, 2, '两条视频扩展名应被迁移');
  assert.equal(legacy.recentMessages[0].media[0].kind, 'video');
  assert.equal(legacy.recentMessages[1].media[0].kind, 'image', 'jpeg 不能被误判成视频');
  assert.equal(legacy.unread[0].media[0].kind, 'video');
  assert.equal(h.migrateVideoMediaKinds(legacy), 0, '迁移必须幂等');
});
await test('local QQ video cache is matched by media.file and stays inside the configured dir', async (h) => {
  // QQ 客户端把收到的视频落在 <Video>/<YYYY-MM>/Ori/<md5>.mp4，文件名就是消息里的 media.file。
  // 命中时应该直接返回本地路径（免走会过期的下载 URL），且只认 Ori、只认配置目录。
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-cache-'));
  const oriDir = path.join(root, '2026-11', 'Ori');
  const thumbDir = path.join(root, '2026-11', 'Thumb');
  fs.mkdirSync(oriDir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });
  const hitFile = path.join(oriDir, 'ca5afd15954ca14f9c0971f4ebd0cb89.mp4');
  fs.writeFileSync(hitFile, Buffer.alloc(2048));
  fs.writeFileSync(path.join(thumbDir, 'ca5afd15954ca14f9c0971f4ebd0cb89.mp4'), Buffer.alloc(2048));
  const video = { localCacheDirs: [root] };
  try {
    const found = h.findLocalVideoFile({ kind: 'video', file: 'ca5afd15954ca14f9c0971f4ebd0cb89.mp4' }, { video });
    assert.equal(found, hitFile, '应按 media.file 精确命中 Ori 文件');
    // 只有 Thumb 时不算命中（缩略图没法抽帧）。
    assert.equal(h.findLocalVideoFile({ file: 'only-thumb.mp4' }, { video }), null);
    fs.writeFileSync(path.join(thumbDir, 'only-thumb.mp4'), Buffer.alloc(2048));
    assert.equal(h.findLocalVideoFile({ file: 'only-thumb.mp4' }, { video }), null, 'Thumb 目录不应命中');
    // 目录名不能拼出路径、非视频扩展名一律不认。
    assert.equal(h.findLocalVideoFile({ file: '../../windows/win.ini' }, { video }), null);
    assert.equal(h.findLocalVideoFile({ file: 'notes.txt' }, { video }), null);
    // 没配置目录时不扫盘。
    assert.equal(h.findLocalVideoFile({ file: 'ca5afd15954ca14f9c0971f4ebd0cb89.mp4' }, { video: { localCacheDirs: [] } }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
await test('inbound voice retries while QQ-side ASR is still generating', async (h) => {
  // QQ 侧转写是异步生成的：第一次 status:failed，稍后再查就有文本（实测 05:04 的事故）。
  h.calls.httpPttScript.push(
    { ok: true, json: { status: 'failed', retcode: 200, data: null, message: '转写结果为空' } },
    { ok: true, json: { status: 'ok', retcode: 0, data: { text: '你好。' } } }
  );
  const cfg = {
    ...h.cfg,
    socialV2: { ...h.cfg.socialV2, voiceInbound: { enabled: true, attempts: 3, retryDelayMs: 200, retryBudgetMs: 5000, timeoutMs: 3000 } }
  };
  const before = h.calls.http.length;
  const out = await h.decorateInboundVoice({
    textContent: '[语音]', plainContent: '[语音]',
    mediaList: [{ kind: 'record', file: 'x.amr' }],
    segments: [{ type: 'record', data: { file: 'x.amr' } }],
    messageId: 5150, isSelf: false, cfg, key: 'private:123'
  });
  assert.match(out.textContent, /\[语音转写\] 你好。/, '第二次请求拿到转写后应写进消息');
  const calls = h.calls.http.slice(before).filter((c) => c.url.endsWith('/fetch_ptt_text'));
  assert.equal(calls.length, 2, '第一次空结果应触发一次重试');
});
await test('inbound voice does not retry a definitive "no voice" answer', async (h) => {
  h.calls.httpPttScript.push({ ok: true, json: { status: 'failed', retcode: 200, data: null, message: '消息中不包含语音' } });
  const cfg = {
    ...h.cfg,
    socialV2: { ...h.cfg.socialV2, voiceInbound: { enabled: true, attempts: 3, retryDelayMs: 200, retryBudgetMs: 5000, timeoutMs: 3000 } }
  };
  const before = h.calls.http.length;
  const out = await h.decorateInboundVoice({
    textContent: '[语音]', plainContent: '[语音]',
    mediaList: [{ kind: 'record', file: 'x.amr' }],
    segments: [{ type: 'record', data: { file: 'x.amr' } }],
    messageId: 5151, isSelf: false, cfg, key: 'private:123'
  });
  assert.match(out.textContent, /\[语音，转写不可用\]/);
  const calls = h.calls.http.slice(before).filter((c) => c.url.endsWith('/fetch_ptt_text'));
  assert.equal(calls.length, 1, '「消息中不包含语音」是确定性结论，不应重试');
});
await test('large inbound files are saved to disk with a path note instead of inline text', async (h) => {
  // 2026-11-22 09:02 事故：121.5MB 的 PDF 被 maxFileBytes=20MB 卡死，模型只能让用户拆分。
  // 现在大文件（> maxInlineFileBytes）照收，落盘后只给路径，正文由模型用本地工具分段读。
  // 默认 20MB，但配置可提到 128MB（121.5MB 的 PDF 要收得下），内联上限默认 32MB。
  assert.equal(h.MAX_FILE_BYTES, 20 * 1024 * 1024, '默认下载上限 20MB');
  const big = await bridgeHarness({ config: { socialV2: { media: { maxFileBytes: 134217728 } } } });
  try {
    assert.equal(big.MAX_FILE_BYTES, 134217728, '配置可把下载上限提到 128MB');
  } finally {
    await big.close();
  }
  assert.equal(h.MAX_INLINE_FILE_BYTES, 32 * 1024 * 1024, '默认内联上限 32MB');
  const note = h.largeFileNote({ name: 'big.pdf', size: 127401984, savedPath: 'state/media/inbound/abc-big.pdf' });
  assert.ok(note.includes('big.pdf'), '说明里要有文件名');
  assert.ok(note.includes('state/media/inbound/abc-big.pdf'), '说明里要有落盘路径');
  assert.ok(note.includes('不内联正文'), '说明要明确不内联正文');
});

await test('per-conversation model policy overrides basic turns but not advanced ones', async (h) => {
  const saved = h.conversationPolicy.setPolicy('private:123', {
    provider: 'deepseek-account',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
    updatedBy: 'console',
  });
  assert.equal(saved.ok, true);
  const policy = h.conversationPolicy.policyFor('private:123');
  assert.equal(policy.hasOverride, true);

  await h.ensureTurnModelFor('fixture-policy-basic', false, 'private:123');
  const basic = h.calls.selectedModels.at(-1);
  assert.equal(basic.model, 'deepseek-v4-pro', '基础回合应使用会话策略里的模型');
  assert.equal(basic.provider, 'deepseek-account');
  assert.equal(basic.reasoningEffort, 'high', '思考强度也要按策略下发');

  // 进阶回合（要看图/视频）刻意不覆盖：否则会被纯文本模型废掉 vision。
  await h.ensureTurnModelFor('fixture-policy-advanced', true, 'private:123');
  const advanced = h.calls.selectedModels.at(-1);
  assert.notEqual(advanced.model, 'deepseek-v4-pro', '进阶回合不得被会话策略覆盖');
  assert.equal(advanced.model, 'deepseek-flash');
  // 没有策略的会话保持全局行为
  await h.ensureTurnModelFor('fixture-policy-none', false, 'private:999');
  assert.equal(h.calls.selectedModels.at(-1).model, 'deepseek-flash');
});

await test('wake lease heartbeat keeps a live turn alive but still expires a dead one', async (h) => {
  // 2026-11-22：重回合（多图/长推理/上游慢）正常跑满 5 分钟，被旧租约误判成「卡死」并解除 busy。
  // 现在改成「有 turn/step/tool 事件就续期」。这里用毫秒覆盖把租约压到 150ms：
  //   · 没有事件 → 到期解除 busy（真卡死的兜底还在）；
  //   · 持续有事件 → 一直续期，不误杀；
  //   · 没有在途租约时，心跳不能凭空造一个。
  const lease = await bridgeHarness({ config: { socialV2: { wakeLeaseMs: 150, wakeLeaseRenewMs: 0 } } });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    assert.equal(lease.PENDING_WAKE_LEASE_MS, 150, '毫秒覆盖只给测试用，应生效');
    const key = 'private:123';
    // 场景 1：回合卡死、不再产生事件 → 租约到期
    lease.pendingWakeKeys.add(key);
    lease.armPendingWakeLease(key);
    assert.ok(lease.pendingWakeLeaseTimers.has(key), '应挂上租约定时器');
    await sleep(320);
    assert.equal(lease.pendingWakeKeys.has(key), false, '没有事件推进时租约到期，照常解除 busy');
    assert.equal(lease.pendingWakeLeaseTimers.has(key), false, '到期后定时器要清干净');
    // 场景 2：回合持续推进 → 心跳续期
    lease.pendingWakeKeys.add(key);
    lease.armPendingWakeLease(key);
    for (let i = 0; i < 6; i += 1) {
      await sleep(60);
      lease.renewPendingWakeLease(key);
    }
    assert.equal(lease.pendingWakeKeys.has(key), true, '持续有事件时心跳必须把租约续上');
    lease.disarmPendingWakeLease(key);
    assert.equal(lease.pendingWakeLeaseTimers.has(key), false, 'disarm 要清掉定时器');
    lease.pendingWakeKeys.delete(key);
    // 场景 3：没有在途租约时，心跳不能凭空造一个
    lease.pendingWakeKeys.add('private:999');
    lease.renewPendingWakeLease('private:999');
    assert.equal(lease.pendingWakeLeaseTimers.has('private:999'), false, '没有租约时心跳不得凭空创建');
    lease.pendingWakeKeys.clear();
  } finally {
    await lease.close();
  }
});

if (failures) process.exitCode = 1;
