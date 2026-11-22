// 文档正文提取的离线回归：不联网、不依赖 Office/PDF 外部程序。
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { decodeTextBuffer, detectDocumentKind, extractDocumentText } from '../src/doc-extract.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, error?.stack || error); }
}

const docx = zipSync({
  'word/document.xml': strToU8(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> 文档</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>'
  )
});

const xlsx = zipSync({
  'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook/>'),
  'xl/sharedStrings.xml': strToU8('<?xml version="1.0"?><sst><si><t>姓名</t></si><si><t>星辰</t></si></sst>'),
  'xl/worksheets/sheet1.xml': strToU8(
    '<?xml version="1.0"?><worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>备注</t></is></c><c r="B2"><v>42</v></c></row>' +
    '</sheetData></worksheet>'
  )
});

const pptx = zipSync({
  'ppt/presentation.xml': strToU8('<?xml version="1.0"?><p:presentation/>'),
  'ppt/slides/slide1.xml': strToU8(
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>' +
    '<a:p><a:r><a:t>标题页</a:t></a:r></a:p><a:p><a:r><a:t>Hello PPT</a:t></a:r></a:p>' +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  )
});

function makePdf(streamText, flate = false) {
  const payload = Buffer.from(`BT /F1 12 Tf (${streamText}) Tj ET`, 'latin1');
  const data = flate ? zlib.deflateSync(payload) : payload;
  const dict = `<< /Length ${data.length}${flate ? ' /Filter /FlateDecode' : ''} >>`;
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n${dict}\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')
  ]);
}

await test('text UTF-8', () => {
  const r = extractDocumentText(Buffer.from('你好，世界\nhello'), { filename: 'a.txt' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'text');
  assert.match(r.text, /你好，世界/);
});

await test('text GB18030 fallback', () => {
  const r = extractDocumentText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), { filename: 'gbk.txt' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '中文');
});

await test('docx paragraphs', () => {
  const r = extractDocumentText(docx, { filename: 'a.docx' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'docx');
  assert.match(r.text, /Hello 文档/);
  assert.match(r.text, /第二段/);
});

await test('xlsx shared strings and inline strings', () => {
  const r = extractDocumentText(xlsx, { filename: 'a.xlsx' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'xlsx');
  assert.match(r.text, /姓名\t星辰/);
  assert.match(r.text, /备注\t42/);
});

await test('pptx slide text', () => {
  const r = extractDocumentText(pptx, { filename: 'a.pptx' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'pptx');
  assert.match(r.text, /标题页/);
  assert.match(r.text, /Hello PPT/);
});

await test('pdf uncompressed text', () => {
  const r = extractDocumentText(makePdf('Hello PDF'), { filename: 'a.pdf' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'pdf');
  assert.match(r.text, /Hello PDF/);
});

await test('pdf flate text', () => {
  const r = extractDocumentText(makePdf('Compressed PDF', true), { filename: 'b.pdf' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'pdf');
  assert.match(r.text, /Compressed PDF/);
});

await test('pdf no text layer -> explicit error', () => {
  const r = extractDocumentText(makePdf('', false), { filename: 'c.pdf' });
  assert.equal(r.ok, false);
  assert.match(r.error, /扫描件|OCR|没有提取/);
});

await test('legacy OLE is rejected with guidance', () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(32)]);
  const r = extractDocumentText(ole, { filename: 'a.doc' });
  assert.equal(r.ok, false);
  assert.match(r.error, /旧版 Office/);
});

await test('binary unknown is rejected', () => {
  const r = extractDocumentText(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]), { filename: 'x.bin' });
  assert.equal(r.ok, false);
});

await test('kind detection by magic', () => {
  assert.equal(detectDocumentKind(docx, 'noext'), 'docx');
  assert.equal(detectDocumentKind(xlsx, 'noext'), 'xlsx');
  assert.equal(detectDocumentKind(pptx, 'noext'), 'pptx');
  assert.equal(detectDocumentKind(makePdf('x'), 'noext'), 'pdf');
});

await test('decode UTF-16LE BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]);
  assert.equal(decodeTextBuffer(buf), '中文');
});

if (failures) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部文档提取用例通过');
