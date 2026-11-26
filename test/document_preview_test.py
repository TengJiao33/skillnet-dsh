import base64
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import unittest

from docx import Document


ROOT = Path(__file__).resolve().parents[1]


def pdf_with_text(text):
    stream = f"BT /F1 12 Tf 36 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
        b" /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]
    data = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(b"%d 0 obj\n" % number + obj + b"\nendobj\n")
    start = len(data)
    data.extend(b"xref\n0 %d\n0000000000 65535 f \n" % (len(offsets) + 1))
    for offset in offsets:
        data.extend(b"%010d 00000 n \n" % offset)
    data.extend(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(offsets) + 1, start))
    return bytes(data)


class DocumentPreviewTests(unittest.TestCase):
    def preview(self, name, data):
        request = {"action": "document-preview", "name": name, "data": base64.b64encode(data).decode()}
        result = subprocess.run([sys.executable, "-X", "utf8", "-B", str(ROOT / "python/worker.py")],
                                input=json.dumps(request), text=True, encoding="utf-8",
                                capture_output=True, timeout=30)
        return json.loads(result.stdout)

    def test_markdown_preview_preserves_text_and_marks_limit(self):
        markdown = self.preview("SOP.md", "# 字段检查\n\n保留原表。".encode())
        self.assertEqual(markdown["data"], {"content": "# 字段检查\n\n保留原表。", "truncated": False})
        preview = self.preview("source.txt", b"a" * 50001)
        self.assertEqual(len(preview["data"]["content"]), 50000)
        self.assertTrue(preview["data"]["truncated"])

    def test_docx_and_pdf_use_actual_sdk_parsers(self):
        doc = Document()
        doc.add_paragraph("字段类型与缺失值")
        table = doc.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "地区"
        table.cell(0, 1).text = "金额"
        encoded = BytesIO()
        doc.save(encoded)
        word = self.preview("notes.docx", encoded.getvalue())
        self.assertTrue(word["ok"], word.get("error"))
        self.assertIn("字段类型与缺失值", word["data"]["content"])
        self.assertIn("地区 | 金额", word["data"]["content"])
        pdf = self.preview("notes.pdf", pdf_with_text("Check original sales records"))
        self.assertTrue(pdf["ok"], pdf.get("error"))
        self.assertIn("Check original sales records", pdf["data"]["content"])

    def test_rejects_unsupported_or_malformed_inputs(self):
        self.assertFalse(self.preview("notes.xls", b"fake")["ok"])
        self.assertFalse(self.preview("broken.docx", b"fake")["ok"])
        self.assertFalse(self.preview("broken.txt", b"\x00a")["ok"])
        self.assertFalse(self.preview("broken.pdf", b"fake")["ok"])


if __name__ == "__main__":
    unittest.main()
