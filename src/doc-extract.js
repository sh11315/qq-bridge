// 文档正文提取：把 QQ 里收到的文件尽量变成模型能读的文字。
//
// 设计边界：
// - 只做“读文本”，不执行宏、不渲染、不解压到磁盘；所有解析都在内存里完成。
// - 单文件硬上限 20 MiB；提取结果默认截到 20000 字符，避免一个文件把上下文塞爆。
// - 旧版 .doc/.xls/.ppt 是 OLE 复合文档，纯 JS 解析成本高，这里明确拒绝并提示另存为新格式。
// - PDF 是“尽力而为”的文本提取：只处理未加密、带文本层的 PDF；扫描件/图片型 PDF 需要 OCR，
//   这里不假装能识别，返回空文本并说明原因。
// - 文档内容是不可信输入：桥接层会把它放进【文件】段，模型只当资料，不当指令。

import path from 'node:path';
import zlib from 'node:zlib';
import { unzipSync } from 'fflate';

export const DOC_DEFAULTS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxChars: 20000
});

const TEXT_EXTS = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.xml', '.html', '.htm', '.xhtml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.log', '.sql', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c',
  '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.ps1',
  '.css', '.scss', '.less', '.vue', '.svelte', '.tex', '.r', '.lua', '.pl', '.swift',
  '.kt', '.kts', '.dart', '.env', '.gitignore', '.dockerfile'
]);

const OLE_EXTS = new Set(['.doc', '.xls', '.ppt', '.msg']);
const ZIP_EXTS = new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz']);

function extOf(filename) {
  return path.extname(String(filename ?? '').trim()).toLowerCase();
}

function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
    }[name.toLowerCase()] ?? ''));
}

/** 去标签、保留段落/制表符的朴素 XML 文本化；只用于我们自己生成的 Office XML。 */
function xmlToPlainText(xml, { tabTags = [], breakTags = [], paragraphTags = [], cellTags = [] } = {}) {
  let s = String(xml ?? '');
  for (const re of tabTags) s = s.replace(re, '\u0001');
  for (const re of breakTags) s = s.replace(re, '\u0002');
  for (const re of paragraphTags) s = s.replace(re, '\u0002');
  for (const re of cellTags) s = s.replace(re, '\u0001');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeXmlEntities(s);
  return s.replace(/\u0001/g, '\t').replace(/\u0002/g, '\n');
}

function cleanText(text) {
  return String(text ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function limitText(text, maxChars) {
  const clean = cleanText(text);
  const limit = Math.max(1000, Number(maxChars) || DOC_DEFAULTS.maxChars);
  if (clean.length <= limit) return { text: clean, truncated: false };
  return {
    text: clean.slice(0, limit) + `\n…（已截断，原文至少 ${clean.length} 字符）`,
    truncated: true
  };
}

/** 文本解码：BOM → UTF-8 → GB18030 → latin1 兜底。 */
export function decodeTextBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(b.subarray(3));
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(b.subarray(2));
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(b.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {}
  try {
    return new TextDecoder('gb18030').decode(b);
  } catch {}
  return b.toString('latin1');
}

function looksLikeText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length === 0) return true;
  const sample = b.subarray(0, Math.min(b.length, 8192));
  let nul = 0;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) nul += 1;
    else if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  if (nul > 0) return false;
  return control / sample.length < 0.05;
}

export function detectDocumentKind(buf, filename = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const ext = extOf(filename);
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const latin = b.toString('latin1');
    if (latin.includes('word/document.xml')) return 'docx';
    if (latin.includes('xl/workbook.xml')) return 'xlsx';
    if (latin.includes('ppt/presentation.xml')) return 'pptx';
    return 'zip';
  }
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1').toLowerCase() === '{\\rtf') return 'rtf';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.rtf') return 'rtf';
  if (OLE_EXTS.has(ext)) return 'ole';
  if (ZIP_EXTS.has(ext)) return 'zip';
  if (TEXT_EXTS.has(ext)) return 'text';
  return looksLikeText(b) ? 'text' : 'unknown';
}

function readZipEntry(zip, name) {
  const data = zip?.[name];
  if (!data) return '';
  return Buffer.from(data).toString('utf8');
}

function unzipOrThrow(buf, filter) {
  try {
    return unzipSync(new Uint8Array(buf), {
      filter: (file) => {
        if (!file || !file.name || file.name.endsWith('/')) return false;
        if (Number(file.originalSize) > 8 * 1024 * 1024) return false;
        return filter ? filter(file) : true;
      }
    });
  } catch (error) {
    throw new Error(`压缩包无法解开：${error?.message ?? error}`);
  }
}

function extractDocx(buf) {
  const wanted = (file) => file.name === 'word/document.xml' || /^word\/(?:header|footer)\d*\.xml$/i.test(file.name);
  const zip = unzipOrThrow(buf, wanted);
  const names = Object.keys(zip).filter((name) => name === 'word/document.xml' || /^word\/(?:header|footer)\d*\.xml$/i.test(name));
  if (!names.length) throw new Error('DOCX 缺少 word/document.xml');
  const pieces = [];
  for (const name of names) {
    const xml = readZipEntry(zip, name);
    if (!xml) continue;
    const text = xmlToPlainText(xml, {
      tabTags: [/<w:tab\b[^>]*\/>/gi],
      breakTags: [/<w:br\b[^>]*\/>/gi],
      paragraphTags: [/<\/w:p>/gi, /<\/w:tr>/gi],
      cellTags: [/<\/w:tc>/gi]
    });
    if (text.trim()) pieces.push(text);
  }
  return { kind: 'docx', label: 'Word', text: pieces.join('\n\n') };
}

function extractXlsx(buf) {
  const wanted = (file) => file.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(file.name);
  const zip = unzipOrThrow(buf, wanted);
  const sharedXml = readZipEntry(zip, 'xl/sharedStrings.xml');
  const shared = [];
  if (sharedXml) {
    for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      const text = decodeXmlEntities(match[1].replace(/<[^>]+>/g, ''));
      shared.push(text);
    }
  }
  const sheetNames = Object.keys(zip)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
  if (!sheetNames.length) throw new Error('XLSX 缺少工作表 XML');
  const pieces = [];
  sheetNames.forEach((name, sheetIndex) => {
    const xml = readZipEntry(zip, name);
    if (!xml) return;
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attrs = cellMatch[1] ?? '';
        const inner = cellMatch[2] ?? '';
        const type = /t="([^"]+)"/i.exec(attrs)?.[1] ?? '';
        let value = /<v>([\s\S]*?)<\/v>/i.exec(inner)?.[1] ?? '';
        if (type === 's') value = shared[Number(value)] ?? '';
        else if (type === 'inlineStr') value = inner.replace(/<[^>]+>/g, '');
        else if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
        else value = decodeXmlEntities(value);
        const ref = /\br="([A-Z]+)\d+"/i.exec(attrs)?.[1] ?? '';
        let col = 0;
        for (const ch of ref.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
        if (col > 0) {
          while (cells.length < col - 1) cells.push('');
        }
        cells.push(String(value).replace(/\r?\n/g, ' ').trim());
        if (cells.length > 80) break;
      }
      if (cells.some((cell) => cell !== '')) rows.push(cells.join('\t'));
      if (rows.length >= 500) break;
    }
    if (rows.length) pieces.push(`工作表 ${sheetIndex + 1}:\n${rows.join('\n')}`);
  });
  return { kind: 'xlsx', label: 'Excel', text: pieces.join('\n\n') };
}

function extractPptx(buf) {
  const wanted = (file) => /^ppt\/slides\/slide\d+\.xml$/i.test(file.name);
  const zip = unzipOrThrow(buf, wanted);
  const slides = Object.keys(zip)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
  if (!slides.length) throw new Error('PPTX 缺少幻灯片 XML');
  const pieces = [];
  slides.forEach((name, index) => {
    const xml = readZipEntry(zip, name);
    if (!xml) return;
    const text = xmlToPlainText(xml, {
      breakTags: [/<a:br\b[^>]*\/>/gi],
      paragraphTags: [/<\/a:p>/gi]
    });
    if (text.trim()) pieces.push(`幻灯片 ${index + 1}:\n${text}`);
  });
  return { kind: 'pptx', label: 'PowerPoint', text: pieces.join('\n\n') };
}

function decodePdfLiteral(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[i + 1];
    if (next == null) break;
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (/[0-7]/.test(next)) {
      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (next === '\n') { /* 续行 */ }
    else out += next;
  }
  if (out.length >= 2 && out.charCodeAt(0) === 0xfe && out.charCodeAt(1) === 0xff) {
    try { return new TextDecoder('utf-16be').decode(Buffer.from(out.slice(2), 'latin1')); } catch {}
  }
  return out;
}

function pdfContentText(content) {
  const value = String(content ?? '');
  const chunks = [];
  const push = (s) => { if (s) chunks.push(s); };
  // Tj / ' / " 的单字符串；TJ 的字符串数组。
  for (const match of value.matchAll(/(\((?:\\.|[^\\()])*\))\s*(?:Tj|'|")/g)) {
    push(decodePdfLiteral(match[1].slice(1, -1)));
  }
  for (const match of value.matchAll(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\s*TJ/g)) {
    for (const inner of match[1].matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      push(decodePdfLiteral(inner[0].slice(1, -1)));
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

function extractPdf(buf) {
  const latin = buf.toString('latin1');
  const pieces = [];
  let pos = 0;
  let streams = 0;
  while (pos < latin.length && streams < 200) {
    const start = latin.indexOf('stream', pos);
    if (start < 0) break;
    let dataStart = start + 6;
    if (latin[dataStart] === '\r') dataStart += 1;
    if (latin[dataStart] === '\n') dataStart += 1;
    const end = latin.indexOf('endstream', dataStart);
    if (end < 0) break;
    const dict = latin.slice(Math.max(0, start - 400), start);
    let data = buf.subarray(dataStart, end);
    if (/\/FlateDecode\b/.test(dict)) {
      try { data = zlib.inflateSync(data, { maxOutputLength: 8 * 1024 * 1024 }); } catch { pos = end + 9; continue; }
    }
    streams += 1;
    const text = pdfContentText(data.toString('latin1'));
    if (text) pieces.push(text);
    pos = end + 9;
  }
  const text = pieces.join('\n');
  return {
    kind: 'pdf',
    label: 'PDF',
    text,
    note: text.trim() ? '' : '未提取到文本：可能是扫描件/图片型 PDF，或字体编码无法直接解码；这类文件需要 OCR。'
  };
}

function extractRtf(buf) {
  let s = buf.toString('latin1');
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_, hex) => {
    try { return new TextDecoder('windows-1252').decode(Buffer.from([parseInt(hex, 16)])); } catch { return ''; }
  });
  s = s.replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536));
  s = s.replace(/\\par[d]?\b/gi, '\n').replace(/\\tab\b/gi, '\t');
  s = s.replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
  return { kind: 'rtf', label: 'RTF', text: s };
}

function extractHtml(text) {
  const stripped = String(text ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(stripped);
}


/**
 * 提取文档正文。
 *
 * @param {Buffer} buf
 * @param {{filename?:string, mime?:string, maxBytes?:number, maxChars?:number}} opts
 * @returns {{ok:true, kind:string, label:string, text:string, note:string, truncated:boolean}|{ok:false, kind:string, error:string}}
 */
export function extractDocumentText(buf, opts = {}) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const maxBytes = Math.max(1024, Number(opts.maxBytes) || DOC_DEFAULTS.maxBytes);
  const maxChars = Math.max(1000, Number(opts.maxChars) || DOC_DEFAULTS.maxChars);
  const filename = String(opts.filename ?? '').trim();
  if (!buffer.length) return { ok: false, kind: 'unknown', error: '文件内容为空' };
  if (buffer.length > maxBytes) {
    return { ok: false, kind: 'unknown', error: `文件 ${buffer.length} 字节，超过上限 ${maxBytes} 字节` };
  }
  const kind = detectDocumentKind(buffer, filename);
  try {
    if (kind === 'ole') {
      return { ok: false, kind, error: '旧版 Office 二进制格式（.doc/.xls/.ppt）暂不支持，请另存为 .docx/.xlsx/.pptx' };
    }
    if (kind === 'zip') {
      return { ok: false, kind, error: '压缩包暂不展开，请解压后把需要的文件单独发过来' };
    }
    let out;
    if (kind === 'docx') out = extractDocx(buffer);
    else if (kind === 'xlsx') out = extractXlsx(buffer);
    else if (kind === 'pptx') out = extractPptx(buffer);
    else if (kind === 'pdf') out = extractPdf(buffer);
    else if (kind === 'rtf') out = extractRtf(buffer);
    else if (kind === 'text') {
      const decoded = decodeTextBuffer(buffer);
      if (!looksLikeText(buffer) && !/[\u4e00-\u9fff]/.test(decoded)) {
        return { ok: false, kind: 'unknown', error: '看起来是二进制文件，无法当作文本读取' };
      }
      out = {
        kind: 'text',
        label: /\.(?:html?|xhtml)$/i.test(filename) ? 'HTML' : '文本',
        text: /\.(?:html?|xhtml)$/i.test(filename) ? extractHtml(decoded) : decoded
      };
    } else {
      return { ok: false, kind: 'unknown', error: '无法识别的文件格式' };
    }
    const limited = limitText(out.text, maxChars);
    if (!limited.text.trim()) {
      return { ok: false, kind, error: out.note || '没有提取到可读文本' };
    }
    return {
      ok: true,
      kind,
      label: out.label,
      text: limited.text,
      note: out.note || (limited.truncated ? '正文较长，已截断' : ''),
      truncated: limited.truncated
    };
  } catch (error) {
    return { ok: false, kind, error: error?.message ?? String(error) };
  }
}
