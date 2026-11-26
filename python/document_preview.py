"""Extract an explicitly uploaded document for the local editable preview."""

from base64 import b64decode
from binascii import Error as Base64Error
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile


MAX_UPLOAD = 4 * 1024 * 1024
MAX_DOCX_EXPANDED = 32 * 1024 * 1024
MAX_TEXT = 50_000


def preview_document(request):
    name = request.get("name")
    data = request.get("data")
    if not isinstance(name, str) or len(name) > 255:
        raise ValueError("请选择有效的文档。")
    ext = Path(name).suffix.lower()
    if ext not in {".md", ".txt", ".docx", ".pdf"}:
        raise ValueError("支持 Markdown、TXT、Word（.docx）和 PDF。")
    if not isinstance(data, str) or not data or len(data) > 4 * ((MAX_UPLOAD + 2) // 3):
        raise ValueError("文档须在 4 MB 以内。")
    try:
        payload = b64decode(data, validate=True)
    except (Base64Error, ValueError):
        raise ValueError("无法读取上传的文档。") from None
    if not payload or len(payload) > MAX_UPLOAD:
        raise ValueError("文档须在 4 MB 以内。")

    if ext in {".md", ".txt"}:
        try:
            content = payload.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise ValueError("请使用 UTF-8 编码的 Markdown 或 TXT。") from None
        if "\x00" in content:
            raise ValueError("该文件包含二进制内容，请选择文本文件。")
    else:
        from skillnet_ai.creator import _OfficeReader

        if ext == ".docx":
            try:
                with ZipFile(BytesIO(payload)) as archive:
                    members = archive.infolist()
                    if sum(member.file_size for member in members) > MAX_DOCX_EXPANDED:
                        raise ValueError("Word 文档展开后过大。")
                    if "word/document.xml" not in archive.namelist():
                        raise ValueError("文件不是可读的 Word 文档。")
            except BadZipFile:
                raise ValueError("文件不是可读的 Word 文档。") from None
        with TemporaryDirectory(prefix="skillnet-document-") as work:
            file = Path(work) / f"source{ext}"
            file.write_bytes(payload)
            try:
                content = _OfficeReader.extract_text(str(file), max_chars=MAX_TEXT + 1)
            except Exception:
                raise ValueError("无法提取文档文字，请检查格式或加密状态。") from None

    content = content.strip()
    if not content:
        raise ValueError("未提取到文字。扫描 PDF 需要先转换为可选中的文字。")
    return {"content": content[:MAX_TEXT], "truncated": len(content) > MAX_TEXT}
