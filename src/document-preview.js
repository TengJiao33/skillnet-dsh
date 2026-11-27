import { extname } from 'node:path';

const maxUpload = 4 * 1024 * 1024;
const maxText = 50_000;

export function previewDocument(request, backend, signal) {
  const { name, data } = request;
  if (typeof name !== 'string' || [...name].length > 255) throw new Error('请选择有效的文档。');
  const ext = extname(name).toLowerCase();
  if (!['.md', '.txt', '.docx', '.pdf'].includes(ext)) throw new Error('支持 Markdown、TXT、Word（.docx）和 PDF。');
  if (ext === '.docx' || ext === '.pdf') return backend({ action: 'document-preview', name, data }, signal);
  signal?.throwIfAborted();
  if (typeof data !== 'string' || !data || data.length > 4 * Math.ceil(maxUpload / 3)) throw new Error('文档须在 4 MB 以内。');
  if (data.length % 4 || /[^A-Za-z0-9+/=]/.test(data) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('无法读取上传的文档。');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > maxUpload) throw new Error('文档须在 4 MB 以内。');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); }
  catch { throw new Error('请使用 UTF-8 编码的 Markdown 或 TXT。'); }
  if (content.includes('\0')) throw new Error('该文件包含二进制内容，请选择文本文件。');
  if (!content) throw new Error('未提取到文字。扫描 PDF 需要先转换为可选中的文字。');
  if (content.length <= maxText) return { content, truncated: false };
  const prefix = Array.from(content.slice(0, maxText * 2 + 1));
  return { content: prefix.slice(0, maxText).join(''), truncated: prefix.length > maxText };
}
