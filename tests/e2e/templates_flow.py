"""
E2E de la etapa 2 (plantillas propias) en tamaño iPhone, con archivos ficticios.
"""
import os
import sys
from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:4173")
SHOTS = os.environ.get("SHOTS_DIR", "/tmp/aa-e2e")
FIX = os.path.join(os.path.dirname(__file__), "..", "fixtures")
os.makedirs(SHOTS, exist_ok=True)
IPHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True,
              has_touch=True, locale="es-CL")


def shot(page, name, full=False):
    page.screenshot(path=f"{SHOTS}/{name}.png", full_page=full)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(**IPHONE, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text)
                if m.type == "error" and not any(c in m.text for c in ("401", "400", "415")) else None)

        page.goto(BASE)
        page.get_by_role("button", name="Entrar como Profesional Demo A").click()
        page.get_by_role("button", name="Plantillas").click()
        expect(page.get_by_role("heading", name="Plantillas")).to_be_visible()

        # Archivo con macros: rechazado con un mensaje claro.
        page.locator("input[type=file]").set_input_files(os.path.join(FIX, "ficha-con-macros-demo.xlsm"))
        expect(page.get_by_role("alert")).to_contain_text("macros")

        # Word: propuesta de campos para revisar.
        page.locator("input[type=file]").set_input_files(os.path.join(FIX, "ficha-demo.docx"))
        expect(page.get_by_role("heading", name="Revisar campos detectados")).to_be_visible()
        expect(page.get_by_text("no promete conservar exactamente el diseño")).to_be_visible()
        shot(page, "21-importar-word", full=True)

        # Corregir: «Hábito tabáquico» con tipo Tabaco (sugerido) y Observaciones solo del profesional.
        obs = page.locator(".tpl-field").filter(has=page.locator("input[value='Observaciones del profesional']"))
        obs.get_by_label("Tipo de dato").select_option("__manual")
        med = page.locator(".tpl-field").filter(has=page.locator("input[value='Fármacos en uso']"))
        expect(med.get_by_label("Revisión obligatoria", exact=False)).to_be_checked()
        expect(med.get_by_label("Revisión obligatoria", exact=False)).to_be_disabled()
        page.get_by_label("Nombre de la plantilla").fill("Ficha de ingreso DEMO")
        page.get_by_role("button", name="Confirmar y crear plantilla").click()
        expect(page.get_by_role("heading", name="Editar plantilla")).to_be_visible()
        expect(page.get_by_role("button", name="Versión 1")).to_be_visible()

        # Editar y versionar.
        page.get_by_role("button", name="Agregar campo").first.click()
        page.locator(".draft-section").first.locator(".tpl-field").last.get_by_label("Nombre del campo").fill("Peso")
        page.get_by_label("Nota de esta versión (opcional)").fill("Agrega peso")
        page.get_by_role("button", name="Guardar nueva versión").click()
        expect(page.get_by_text("Guardada como versión 2")).to_be_visible()
        page.get_by_role("button", name="Versión 1").click()
        expect(page.get_by_text("Estás viendo la versión 1")).to_be_visible()
        expect(page.locator("input[value='Peso']")).to_have_count(0)
        shot(page, "22-version-anterior")
        page.get_by_role("button", name="Volver a la última").click()

        # Excel: hoja y celda editables.
        page.get_by_role("button", name="Plantillas").click()
        page.locator("input[type=file]").set_input_files(os.path.join(FIX, "ficha-demo.xlsx"))
        expect(page.get_by_role("heading", name="Revisar campos detectados")).to_be_visible()
        motivo = page.locator(".tpl-field").filter(has=page.locator("input[value='Motivo de consulta']"))
        expect(motivo.get_by_label("Hoja")).to_have_value("Ingreso")
        expect(motivo.get_by_label("Celda")).to_have_value("B3")
        motivo.get_by_label("Celda").fill("c3")
        expect(motivo.get_by_label("Celda")).to_have_value("C3")
        formula = page.locator(".tpl-field").filter(has=page.locator("input[value='Puntaje calculado']"))
        expect(formula.get_by_text("fórmula")).to_be_visible()
        shot(page, "23-importar-excel", full=True)
        page.get_by_role("button", name="Confirmar y crear plantilla").click()
        expect(page.get_by_role("heading", name="Editar plantilla")).to_be_visible()

        # Entrevista con la plantilla Word importada.
        page.get_by_role("button", name="Plantillas").click()
        page.get_by_role("button", name="Entrevistas").click()
        page.get_by_label("Plantilla para la nueva anamnesis").select_option(label="Ficha de ingreso DEMO (v2)")
        page.get_by_role("button", name="Nueva entrevista").click()
        page.get_by_role("button", name="Iniciar escucha").click()
        page.get_by_label("Informé lo anterior y la persona aceptó.").check()
        page.get_by_role("button", name="Registrar e iniciar").click()
        page.wait_for_selector(".listen-detenida", timeout=40000)
        for sp, role in (("1", "profesional"), ("2", "paciente"), ("3", "acompanante")):
            page.get_by_label(f"Hablante {sp}", exact=True).select_option(role)
        page.get_by_role("tab", name="Anamnesis").click()
        expect(page.get_by_role("heading", name="Fármacos en uso")).to_be_visible()
        expect(page.get_by_role("heading", name="Peso")).to_be_visible()
        shot(page, "24-borrador-plantilla-propia", full=True)

        # Resolver lo pendiente confirmando lo propuesto.
        for _ in range(10):
            pending = page.locator(".field.st-requiere_revision")
            if pending.count() == 0:
                break
            pending.first.get_by_role("button", name="Confirmar").click()
            page.wait_for_timeout(200)
        page.get_by_role("tab", name="Finalizar").click()
        page.get_by_label("Revisé el borrador completo.", exact=False).check()
        page.get_by_role("button", name="Finalizar anamnesis").click()
        link = page.get_by_role("link", name="Word (formato de tu plantilla)")
        expect(link).to_be_visible()
        with page.expect_download() as d:
            link.click()
        path = d.value.path()
        assert d.value.suggested_filename.endswith("formato-original.docx"), d.value.suggested_filename
        import zipfile
        xml = zipfile.ZipFile(path).read("word/document.xml").decode("utf8")
        assert "DATOS FICTICIOS" in xml and "[DEMO]" in xml
        shot(page, "25-exportar-formato-original", full=True)

        assert not errors, errors
        browser.close()
    print("E2E OK: plantillas propias (Word y Excel) en tamaño iPhone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
