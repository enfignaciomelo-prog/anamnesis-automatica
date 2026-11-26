"""Genera plantillas FICTICIAS en blanco para las pruebas (tests/fixtures).

No contienen datos de pacientes: son formularios vacíos con etiquetas.
Uso: python3 scripts/make-fixtures.py
"""
import zipfile
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from openpyxl import Workbook
from openpyxl.workbook.defined_name import DefinedName
from PIL import Image, ImageDraw, ImageFont

OUT = Path("tests/fixtures")
OUT.mkdir(parents=True, exist_ok=True)


def bookmark(paragraph, name, bid):
    start = OxmlElement("w:bookmarkStart")
    start.set(qn("w:id"), str(bid))
    start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(bid))
    paragraph._p.append(start)
    paragraph._p.append(end)


def make_docx():
    d = Document()
    d.add_heading("Ficha de ingreso DEMO", level=1)
    d.add_paragraph("Formulario ficticio para pruebas de Anamnesis Automática.")
    d.add_heading("Datos de la consulta", level=2)
    p = d.add_paragraph("Motivo de consulta: ")
    bookmark(p, "motivo_consulta", 1)
    d.add_paragraph("Fármacos en uso: ______________")
    d.add_paragraph("Alergias:")
    d.add_heading("Antecedentes", level=2)
    p = d.add_paragraph("Antecedentes familiares: ")
    bookmark(p, "ant_familiares", 2)
    d.add_paragraph("Hábito tabáquico:")
    d.add_paragraph("Observaciones del profesional:")
    d.save(OUT / "ficha-demo.docx")


def make_xlsx(path, macros=False):
    wb = Workbook()
    ws = wb.active
    ws.title = "Ingreso"
    ws["A1"] = "Ficha de ingreso DEMO"
    ws["A3"] = "Motivo de consulta:"
    ws["A4"] = "Medicamentos:"
    ws["A5"] = "Alergias:"
    ws["A6"] = "Puntaje calculado:"
    ws["B6"] = "=LEN(B3)"
    ws["A8"] = "Fecha"
    ws["B8"] = "Hora"
    ws2 = wb.create_sheet("Antecedentes")
    ws2["A2"] = "Antecedentes familiares:"
    ws2["A3"] = "Tabaco:"
    wb.defined_names["Alcohol_consumo"] = DefinedName("Alcohol_consumo", attr_text="Antecedentes!$B$4")
    wb.save(path)
    if macros:
        # Simula un libro con macros: debe rechazarse sin abrir su contenido.
        with zipfile.ZipFile(path, "a") as z:
            z.writestr("xl/vbaProject.bin", b"\x00FAKE-VBA-DEMO")


def make_pdfs():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(OUT / "ficha-demo.pdf"), pagesize=A4)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(60, 790, "FICHA DE INGRESO DEMO")
    c.setFont("Helvetica", 11)
    y = 750
    for label in ["Motivo de consulta: ________", "Alergias: ________", "Antecedentes quirúrgicos: ________"]:
        c.drawString(60, y, label)
        y -= 28
    c.save()

    # «Escaneo»: imagen sin capa de texto.
    img = Image.new("L", (1240, 1754), 255)
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 44)
    except OSError:
        font = ImageFont.load_default()
    y = 200
    for label in ["FICHA DEMO ESCANEADA", "Motivo de consulta:", "Alergias:", "Medicamentos:"]:
        d.text((120, y), label, fill=0, font=font)
        y += 110
    img.save(OUT / "ficha-escaneada-demo.pdf", "PDF", resolution=150)


if __name__ == "__main__":
    make_docx()
    make_xlsx(OUT / "ficha-demo.xlsx")
    make_xlsx(OUT / "ficha-con-macros-demo.xlsm", macros=True)
    make_pdfs()
    print("Plantillas ficticias generadas en", OUT)
