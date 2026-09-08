import os
import subprocess
import tempfile
import logging
from pathlib import Path
from typing import Any, Optional
import docx
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from app.core.config import settings
from app.services import gotenberg_client

logger = logging.getLogger(__name__)


def set_cell_background(cell, fill_hex: str):
    """Set the background color of a docx table cell."""
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), fill_hex)
    tcPr.append(shd)


class DocumentExportService:
    """
    Generates real-time DOCX and PDF exports from structured template sections,
    fields, and rich content using python-docx, LibreOffice, and PDF converters.
    """

    @staticmethod
    def create_docx_from_sections(
        title: str,
        subtitle: Optional[str],
        sections: list[dict[str, Any]],
        output_path: str,
        project_meta: Optional[dict[str, Any]] = None,
    ) -> str:
        """
        Build a polished Word Document (.docx) representing the real-time document
        with AmperePro styling, tables, and structured sections.
        """
        doc = docx.Document()

        # Page margins
        for section in doc.sections:
            section.top_margin = Inches(0.8)
            section.bottom_margin = Inches(0.8)
            section.left_margin = Inches(0.8)
            section.right_margin = Inches(0.8)

        # Header Table (AmperePro Style)
        meta_table = doc.add_table(rows=3, cols=3)
        meta_table.alignment = WD_TABLE_ALIGNMENT.CENTER
        meta_table.autofit = False

        # Apply cell widths
        widths = [Inches(2.2), Inches(2.8), Inches(2.0)]
        for row in meta_table.rows:
            for i, width in enumerate(widths):
                row.cells[i].width = width

        # Fill header data
        # Cell (0,0) Brand
        c_brand = meta_table.cell(0, 0)
        c_brand.merge(meta_table.cell(1, 0))
        p_brand = c_brand.paragraphs[0]
        p_brand.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r_brand = p_brand.add_run("AmperePro\nEngineers")
        r_brand.font.size = Pt(13)
        r_brand.font.bold = True
        r_brand.font.color.rgb = RGBColor(26, 58, 107)  # #1A3A6B

        # Project Meta
        spec_no = (project_meta or {}).get("spec_no", "IP009-43-00-01")
        rev = (project_meta or {}).get("revision", "0")
        proj_no = (project_meta or {}).get("project_no", "IP-009")

        meta_table.cell(0, 1).paragraphs[0].add_run(f"SPEC. NO. : {spec_no}").bold = True
        meta_table.cell(0, 2).paragraphs[0].add_run(f"REV. : {rev}").bold = True
        meta_table.cell(1, 1).paragraphs[0].add_run(f"PROJECT NO : {proj_no}").bold = True
        meta_table.cell(1, 2).paragraphs[0].add_run("SHEET : 1 OF 1").bold = True

        c_desc = meta_table.cell(2, 0)
        c_desc.merge(meta_table.cell(2, 2))
        p_desc = c_desc.paragraphs[0]
        p_desc.add_run(f"DESCRIPTION : {title}").bold = True

        # Style header table borders and cell backgrounds
        for row in meta_table.rows:
            for cell in row.cells:
                set_cell_background(cell, "F8FAFC")
                for p in cell.paragraphs:
                    p.paragraph_format.space_before = Pt(3)
                    p.paragraph_format.space_after = Pt(3)
                    for r in p.runs:
                        r.font.name = "Arial"
                        if r != r_brand:
                            r.font.size = Pt(9.5)

        doc.add_paragraph().paragraph_format.space_after = Pt(12)

        # Document Title Banner
        p_title = doc.add_paragraph()
        p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r_title = p_title.add_run(title.upper())
        r_title.font.name = "Arial"
        r_title.font.size = Pt(18)
        r_title.font.bold = True
        r_title.font.color.rgb = RGBColor(26, 58, 107)
        p_title.paragraph_format.space_after = Pt(4)

        if subtitle:
            p_sub = doc.add_paragraph()
            p_sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
            r_sub = p_sub.add_run(subtitle)
            r_sub.font.name = "Arial"
            r_sub.font.size = Pt(12)
            r_sub.font.italic = True
            r_sub.font.color.rgb = RGBColor(100, 116, 139)
            p_sub.paragraph_format.space_after = Pt(16)

        # Render each section
        for idx, sec in enumerate(sections, 1):
            sec_name = sec.get("section_name") or sec.get("name") or f"Section {idx}"
            sec_num = sec.get("section_number") or str(idx)
            sec_content = sec.get("content") or sec.get("text") or ""
            fields = sec.get("fields") or []

            # Section Heading
            h = doc.add_paragraph()
            h.paragraph_format.space_before = Pt(16)
            h.paragraph_format.space_after = Pt(6)
            r_num = h.add_run(f"{sec_num} ")
            r_num.font.name = "Arial"
            r_num.font.bold = True
            r_num.font.size = Pt(13)
            r_num.font.color.rgb = RGBColor(249, 115, 22)  # Accent orange

            r_name = h.add_run(sec_name.upper())
            r_name.font.name = "Arial"
            r_name.font.bold = True
            r_name.font.size = Pt(13)
            r_name.font.color.rgb = RGBColor(26, 58, 107)

            # If section has rich content / text
            if sec_content:
                import re
                clean_text = re.sub(r'<br\s*/?>', '\n', sec_content, flags=re.IGNORECASE)
                clean_text = re.sub(r'</p>', '\n\n', clean_text, flags=re.IGNORECASE)
                clean_text = re.sub(r'<[^>]+>', '', clean_text)
                paragraphs = [p.strip() for p in clean_text.split('\n') if p.strip()]

                for text_para in paragraphs:
                    p = doc.add_paragraph()
                    p.paragraph_format.space_after = Pt(4)
                    p.paragraph_format.line_spacing = 1.15
                    r = p.add_run(text_para)
                    r.font.name = "Arial"
                    r.font.size = Pt(10.5)

            # If section has key-value fields, render in clean table
            if fields:
                field_table = doc.add_table(rows=len(fields) + 1, cols=2)
                field_table.alignment = WD_TABLE_ALIGNMENT.CENTER
                field_table.autofit = False

                for row in field_table.rows:
                    row.cells[0].width = Inches(2.8)
                    row.cells[1].width = Inches(4.2)

                # Header row
                hdr_cells = field_table.rows[0].cells
                hdr_cells[0].paragraphs[0].add_run("FIELD / PARAMETER").bold = True
                hdr_cells[1].paragraphs[0].add_run("SPECIFIED / EXTRACTED VALUE").bold = True

                set_cell_background(hdr_cells[0], "1A3A6B")
                set_cell_background(hdr_cells[1], "1A3A6B")

                for cell in hdr_cells:
                    for p in cell.paragraphs:
                        for r in p.runs:
                            r.font.name = "Arial"
                            r.font.size = Pt(9.5)
                            r.font.color.rgb = RGBColor(255, 255, 255)

                for f_idx, field in enumerate(fields, 1):
                    row_cells = field_table.rows[f_idx].cells
                    f_label = field.get("field_label") or field.get("label") or field.get("field_id") or "Field"
                    f_val = str(field.get("value") or field.get("default_value") or "—")

                    p0 = row_cells[0].paragraphs[0]
                    p0.add_run(f_label).bold = True
                    p1 = row_cells[1].paragraphs[0]
                    p1.add_run(f_val)

                    bg_color = "F8FAFC" if f_idx % 2 == 0 else "FFFFFF"
                    set_cell_background(row_cells[0], bg_color)
                    set_cell_background(row_cells[1], bg_color)

                    for cell in row_cells:
                        for p in cell.paragraphs:
                            p.paragraph_format.space_before = Pt(3)
                            p.paragraph_format.space_after = Pt(3)
                            for r in p.runs:
                                r.font.name = "Arial"
                                r.font.size = Pt(9.5)

                doc.add_paragraph().paragraph_format.space_after = Pt(8)

        # Save docx
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(output_file))
        return str(output_file)

    @classmethod
    def convert_docx_to_pdf(cls, docx_path: str, pdf_path: Optional[str] = None) -> str:
        """
        Converts a .docx file to .pdf using LibreOffice (Gotenberg / headless soffice)
        with PyMuPDF or pdfkit fallback.
        """
        docx_file = Path(docx_path).resolve()
        if not docx_file.exists():
            raise FileNotFoundError(f"Source docx file not found: {docx_path}")

        if pdf_path:
            pdf_file = Path(pdf_path).resolve()
            pdf_file.parent.mkdir(parents=True, exist_ok=True)
        else:
            pdf_file = docx_file.with_suffix(".pdf")

        # 1. Try Gotenberg if available
        if gotenberg_client.is_configured():
            try:
                res = gotenberg_client.convert_docx_to_pdf(docx_file, pdf_file.parent)
                if res.exists() and res != pdf_file:
                    import shutil
                    shutil.move(str(res), str(pdf_file))
                if pdf_file.exists() and pdf_file.stat().st_size > 0:
                    return str(pdf_file)
            except Exception as e:
                logger.warning(f"Gotenberg docx->pdf conversion failed: {e}. Falling back to LibreOffice.")

        # 2. Try local LibreOffice (soffice)
        soffice_binary = settings.LIBREOFFICE_PATH or "soffice"
        for candidate in [soffice_binary, "soffice", "libreoffice", r"C:\Program Files\LibreOffice\program\soffice.exe", r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"]:
            if Path(candidate).exists() or candidate in ("soffice", "libreoffice"):
                try:
                    cmd = [
                        candidate,
                        "--headless",
                        "--convert-to", "pdf",
                        "--outdir", str(pdf_file.parent),
                        str(docx_file),
                    ]
                    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
                    expected_pdf = pdf_file.parent / (docx_file.stem + ".pdf")
                    if expected_pdf.exists() and expected_pdf.stat().st_size > 0:
                        if expected_pdf != pdf_file:
                            import shutil
                            shutil.move(str(expected_pdf), str(pdf_file))
                        return str(pdf_file)
                except Exception as e:
                    logger.warning(f"LibreOffice command {candidate} failed: {e}")

        # 3. Fallback: PyMuPDF / docx preview / pdfkit
        try:
            import fitz
            doc_fitz = fitz.open()
            d = docx.Document(str(docx_file))
            page = doc_fitz.new_page(width=595, height=842)  # A4

            # ── 1. CHEMTEX Header Box Table (Matching Reference Flow) ──
            # Outer Box: (40, 30, 555, 110)
            page.draw_rect(fitz.Rect(40, 30, 555, 110), color=(0.0, 0.0, 0.0), width=1.0)
            # Vertical Dividers
            page.draw_line(fitz.Point(240, 30), fitz.Point(240, 110), color=(0.0, 0.0, 0.0), width=0.8)
            page.draw_line(fitz.Point(440, 30), fitz.Point(440, 83), color=(0.0, 0.0, 0.0), width=0.8)
            # Horizontal Dividers
            page.draw_line(fitz.Point(240, 56), fitz.Point(555, 56), color=(0.0, 0.0, 0.0), width=0.8)
            page.draw_line(fitz.Point(40, 83), fitz.Point(555, 83), color=(0.0, 0.0, 0.0), width=0.8)

            # Header Texts
            page.insert_text(fitz.Point(100, 55), "CHEMTEX", fontsize=12, color=(0, 0, 0))
            page.insert_text(fitz.Point(245, 47), "SPEC. NO.   :  IP009-43-00-01", fontsize=8.5, color=(0, 0, 0))
            page.insert_text(fitz.Point(445, 47), "REV. 0", fontsize=8.5, color=(0, 0, 0))

            page.insert_text(fitz.Point(245, 73), "PROJECT NO :  IP009", fontsize=8.5, color=(0, 0, 0))
            page.insert_text(fitz.Point(445, 73), "SHT. 1 OF 20", fontsize=8.5, color=(0, 0, 0))

            page.insert_text(fitz.Point(45, 100), "AREA:  ELECTRICAL", fontsize=8.5, color=(0, 0, 0))
            page.insert_text(fitz.Point(245, 100), "DESCRIPTION :  ELECTRICAL DESIGN BASIS", fontsize=8.5, color=(0, 0, 0))

            y = 150
            for p in d.paragraphs:
                if not p.text.strip():
                    y += 10
                    continue
                if y > 780:
                    page = doc_fitz.new_page(width=595, height=842)
                    y = 50
                is_bold = any(r.bold for r in p.runs)
                font_size = 14 if (is_bold and len(p.text) < 40) else (10 if is_bold else 9)
                # Center cover page title elements
                x = (595 - len(p.text) * (font_size * 0.5)) / 2 if font_size >= 14 else 50
                x = max(50, x)
                page.insert_text(fitz.Point(x, y), p.text[:95], fontsize=font_size, color=(0, 0, 0))
                y += 22 if font_size >= 14 else 14

            # Render tables if present
            for table in d.tables:
                if y > 720:
                    page = doc_fitz.new_page(width=595, height=842)
                    y = 50
                for row in table.rows:
                    row_txt = "  |  ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                    if row_txt:
                        if y > 780:
                            page = doc_fitz.new_page(width=595, height=842)
                            y = 50
                        page.insert_text(fitz.Point(50, y), row_txt[:100], fontsize=8.5, color=(0.1, 0.1, 0.1))
                        y += 14

            doc_fitz.save(str(pdf_file))
            doc_fitz.close()
            return str(pdf_file)
        except Exception as exc:
            logger.error(f"PyMuPDF fallback failed: {exc}")

        raise RuntimeError("Could not convert DOCX to PDF using LibreOffice, Gotenberg, or PyMuPDF")
