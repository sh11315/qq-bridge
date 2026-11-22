// QQ 文件/文档链路的离线回归：file 段 → 字节 → 正文 → 模型文本 part。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, error?.stack || error); }
}

const h = await bridgeHarness();
try {
  await test('file segment is extracted', () => {
    const media = h.extractMediaFromSegments([{ type: 'file', data: { file: 'base64://5L2g5aW977yM5LiW55WM', name: 'a.txt', file_size: '12' } }]);
    assert.equal(media.length, 1);
    assert.equal(media[0].kind, 'file');
    assert.equal(media[0].name, 'a.txt');
    assert.equal(media[0].size, 12);
  });

  await test('text file becomes prompt text', async () => {
    const media = h.extractMediaFromSegments([{ type: 'file', data: { file: 'base64://5L2g5aW977yM5LiW55WM', name: 'a.txt' } }]);
    const parts = await h.resolveMediaList(media, 'private:1');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'text');
    assert.match(parts[0].text, /【文件：a.txt · 文本/);
    assert.match(parts[0].text, /你好，世界/);
  });

  await test('docx file becomes prompt text', async () => {
    const docx = zipSync({
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>合同正文</w:t></w:r></w:p></w:body></w:document>')
    });
    const file = 'base64://' + Buffer.from(docx).toString('base64');
    const media = h.extractMediaFromSegments([{ type: 'file', data: { file, name: '合同.docx' } }]);
    const parts = await h.resolveMediaList(media, 'private:1');
    assert.equal(parts.length, 1);
    assert.match(parts[0].text, /【文件：合同\.docx · Word/);
    assert.match(parts[0].text, /合同正文/);
  });

  await test('missing bytes gives a clear failure', async () => {
    const media = h.extractMediaFromSegments([{ type: 'file', data: { file: 'a.txt', name: 'a.txt' } }]);
    const parts = await h.resolveMediaList(media, 'private:1');
    assert.equal(parts.length, 1);
    assert.match(parts[0].text, /读取失败/);
  });

  await test('more than two files are skipped', async () => {
    const one = { type: 'file', data: { file: 'base64://YQ==', name: 'a.txt' } };
    const media = h.extractMediaFromSegments([one, one, one]);
    const parts = await h.resolveMediaList(media, 'private:1');
    assert.match(parts.map((p) => p.text).join('\n'), /超过单条 2 个文件上限/);
  });

  await test('received file is saved under state/media/inbound and logged', async () => {
    const name = '保存测试.txt';
    const file = 'base64://' + Buffer.from('落盘内容', 'utf8').toString('base64');
    const media = h.extractMediaFromSegments([{ type: 'file', data: { file, name } }]);
    const parts = await h.resolveMediaList(media, 'private:1');
    assert.match(parts[0].text, /落盘内容/);
    const dir = path.join(h.temp, 'state', 'media', 'inbound');
    const files = fs.readdirSync(dir);
    const saved = files.filter((name) => /保存测试\.txt$/.test(name));
    assert.equal(saved.length, 1, `应落盘 1 个保存测试.txt，实际 ${files.length} 个文件：${files.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(dir, saved[0]), 'utf8'), '落盘内容');
    const log = fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8');
    assert.match(log, /\[file\] 收到文件「保存测试\.txt」/);
    assert.match(log, /已保存 state[\\/]media[\\/]inbound/);
  });

  await test('image sent as file goes through the image path', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
    const media = h.extractMediaFromSegments([{ type: 'file', data: { file: 'base64://' + png.toString('base64'), name: 'pic.png' } }]);
    const parts = await h.resolveMediaList(media, 'private:1');
    assert.equal(parts[0].type, 'text');
    assert.match(parts[0].text, /图片/);
    const image = parts.find((part) => part.type === 'image');
    assert.ok(image, '图片文件应产生 image part');
    assert.equal(image.mediaType, 'image/png');
    assert.ok(image.data.length > 0);
  });

  await test('fetchMediaData returns file text for the image/file tool', async () => {
    const file = 'base64://' + Buffer.from('工具读取的文件正文', 'utf8').toString('base64');
    const data = await h.fetchMediaData([{ kind: 'file', name: '说明.txt', file }], 'private:1');
    assert.equal(data.length, 1);
    assert.equal(data[0].kind, 'file');
    assert.match(data[0].text, /工具读取的文件正文/);
  });

  await test('reserved2 stores text file content as fileText for the wake snapshot', async () => {
    const file = 'base64://' + Buffer.from('仿真模式也要看到这段正文', 'utf8').toString('base64');
    h.setMode('reserved2');
    h.socialV2.paused = true; // 只验证入库，不真的排唤醒
    try {
      await h.handleIncoming('group', '456', {
        user_id: '999',
        group_id: '456',
        message_id: 'm-file-1',
        message: [{ type: 'file', data: { file, name: '仿真说明.txt' } }],
        sender: { card: '小明', nickname: '小明' }
      }, h.cfg);
    } finally {
      h.socialV2.paused = false;
      h.setMode('chat');
    }
    const st = h.getSocialV2State('group:456');
    const msg = st.unread[st.unread.length - 1];
    assert.ok(msg, '文件消息应进入未读');
    assert.equal(msg.media[0].kind, 'file', 'file 段不能被拍平成 image');
    assert.match(msg.fileText, /仿真模式也要看到这段正文/);
    const snapshot = JSON.stringify(h.buildWakeSnapshotV2('group:456'));
    assert.match(snapshot, /仿真模式也要看到这段正文/);
  });
} finally {
  await h.close();
}

// 段里的 data.url 优先于 base64/file：不能因为带了 file 就跳过网关给的下载地址。
await test('segment url is preferred and fetched through safeFetchBuffer', async () => {
  const seen = [];
  const h2 = await bridgeHarness({ globals: {
    safeFetchFileBuffer: async (url) => {
      seen.push(String(url));
      return { buffer: Buffer.from('来自 URL 的正文', 'utf8'), mimeType: 'text/plain' };
    }
  } });
  try {
    const parts = await h2.resolveMediaList([{
      kind: 'file',
      url: 'https://files.example/a.txt',
      file: 'base64://' + Buffer.from('不该用的本地内容', 'utf8').toString('base64'),
      name: 'a.txt'
    }], 'group:456');
    assert.deepEqual(seen, ['https://files.example/a.txt']);
    assert.match(parts[0].text, /来自 URL 的正文/);
  } finally {
    await h2.close();
  }
});

// 网关不给 get_group_file_url 时，退到 OneBot get_file 换下载链接。
await test('get_file fallback downloads a URL and refuses local paths', async () => {
  const seen = [];
  const h3 = await bridgeHarness({ globals: {
    safeFetchFileBuffer: async (url) => {
      seen.push(String(url));
      return { buffer: Buffer.from('get_file 正文', 'utf8'), mimeType: 'text/plain' };
    }
  } });
  try {
    const requests = [];
    h3.bot.request = async (action, params) => {
      requests.push({ action, params });
      return { status: 'ok', retcode: 0, data: { url: 'https://files.example/b.txt' } };
    };
    const parts = await h3.resolveMediaList([{ kind: 'file', fileId: 'fid-1', name: 'b.txt' }], 'group:456');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, 'get_file');
    assert.equal(requests[0].params.file_id, 'fid-1');
    assert.deepEqual(seen, ['https://files.example/b.txt']);
    assert.match(parts[0].text, /get_file 正文/);

    // get_file 只返回本地路径时必须拒绝，绝不能直接读盘。
    seen.length = 0;
    h3.bot.request = async () => ({ status: 'ok', retcode: 0, data: { file: 'C:\\Windows\\win.ini' } });
    const rejected = await h3.resolveMediaList([{ kind: 'file', fileId: 'fid-2', name: 'c.txt' }], 'group:456');
    assert.equal(seen.length, 0);
    assert.match(rejected[0].text, /本地路径/);
  } finally {
    await h3.close();
  }
});

if (failures) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部文件媒体用例通过');
