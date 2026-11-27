"""
Prueba de extremo a extremo del modo demostración, en tamaño iPhone.
Se ejecuta con la skill webapp-testing (scripts/with_server.py); ver package.json.

Cubre: consentimiento, pausa por segundo plano y reanudación, transcripción
provisional y definitiva, asignación de hablantes, revisión obligatoria,
finalización, exportación, separación entre profesionales y ausencia de
datos clínicos guardados en el navegador.
"""
import os
import sys
from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:4173")
SHOTS = os.environ.get("SHOTS_DIR", "/tmp/aa-e2e")
os.makedirs(SHOTS, exist_ok=True)
IPHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True,
              has_touch=True, locale="es-CL")


def shot(page, name, full=False):
    page.screenshot(path=f"{SHOTS}/{name}.png", full_page=full)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(**IPHONE)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text)
                if m.type == "error" and "401" not in m.text else None)

        page.goto(BASE)
        page.wait_for_load_state("networkidle")
        expect(page.get_by_text("Demostración con datos ficticios")).to_be_visible()
        shot(page, "01-inicio")

        page.get_by_role("button", name="Entrar como Profesional Demo A").click()
        page.get_by_role("button", name="Nueva entrevista").click()
        expect(page.get_by_text("Conectado")).to_be_visible()

        # Consentimiento obligatorio antes de escuchar.
        page.get_by_role("button", name="Iniciar escucha").click()
        start = page.get_by_role("button", name="Registrar e iniciar")
        expect(start).to_be_disabled()
        shot(page, "02-consentimiento")
        page.get_by_label("Informé lo anterior y la persona aceptó.").check()
        start.click()
        expect(page.get_by_text("Escuchando", exact=True)).to_be_visible()
        expect(page.locator(".interim")).to_be_visible(timeout=5000)
        shot(page, "03-escuchando")

        # Pausar y reanudar con los controles.
        page.get_by_role("button", name="Pausar").click()
        expect(page.locator(".listen-pausada")).to_be_visible()
        expect(page.locator(".interim")).to_have_count(0)
        page.get_by_role("button", name="Reanudar").click()
        expect(page.locator(".listen-escuchando")).to_be_visible()

        # Simula que la app pasa a segundo plano (llamada, bloqueo): debe pausar.
        page.evaluate("""() => {
            Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        expect(page.get_by_text("dejó de estar en pantalla")).to_be_visible(timeout=5000)
        expect(page.get_by_role("button", name="Reanudar")).to_be_visible()
        shot(page, "04-pausa-segundo-plano")
        page.evaluate("""() => {
            Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true});
        }""")
        page.get_by_role("button", name="Reanudar").click()
        expect(page.get_by_text("Escuchando", exact=True)).to_be_visible()

        # Termina el guion ficticio (o se detiene si aún escucha).
        page.wait_for_selector(".listen-detenida", timeout=40000)
        expect(page.locator(".segment")).to_have_count(20)

        # Sin hablantes asignados todo queda en revisión.
        page.get_by_role("tab", name="Anamnesis").click()
        expect(page.locator(".field.st-propuesto")).to_have_count(0)
        page.get_by_role("tab", name="Entrevista").click()
        for sp, role in (("1", "profesional"), ("2", "paciente"), ("3", "acompanante")):
            page.get_by_label(f"Hablante {sp}", exact=True).select_option(role)
        expect(page.locator(".segment.role-paciente").first).to_be_visible()
        shot(page, "05-transcripcion", full=True)

        page.get_by_role("tab", name="Anamnesis").click()
        expect(page.locator("#field-actividad_fisica .chip")).to_have_text("○ No referido")
        expect(page.locator("#field-medicamentos .chip")).to_have_text("▲ Requiere revisión")
        expect(page.locator("#field-familiares .cls").first).to_have_text("Familiar")
        shot(page, "06-borrador", full=True)

        # Tocar un respaldo lleva al fragmento en la transcripción.
        page.locator("#field-quirurgicos .evidence").first.click()
        expect(page.locator(".segment.flash")).to_have_count(1)
        page.get_by_role("tab", name="Anamnesis").click()

        # Medicamentos: el profesional escribe su propio texto.
        med = page.locator("#field-medicamentos")
        med.get_by_role("button", name="Editar").click()
        med.locator("textarea").fill("Metformina 850 mg, frecuencia a confirmar con receta; losartán 50 mg en la mañana")
        med.get_by_role("button", name="Guardar y confirmar").click()
        expect(med.locator(".chip")).to_have_text("✓ Confirmado")
        expect(med.get_by_text("Editado por ti")).to_be_visible()

        page.locator("#field-alergias").get_by_role("button", name="Confirmar").click()
        expect(page.locator("#field-alergias .chip")).to_have_text("✓ Confirmado")
        expect(page.locator(".tab .count")).to_have_count(0)

        page.get_by_role("tab", name="Finalizar").click()
        final = page.get_by_role("button", name="Finalizar anamnesis")
        expect(final).to_be_disabled()
        page.get_by_label("Revisé el borrador completo.", exact=False).check()
        final.click()
        expect(page.get_by_text("Finalizada y confirmada")).to_be_visible()
        shot(page, "07-finalizada", full=True)

        # Exportaciones (misma sesión).
        href = page.get_by_role("link", name="Texto (.txt)").get_attribute("href")
        txt = page.request.get(BASE + href).text()
        assert "DATOS FICTICIOS" in txt and "Actividad física: No referido" in txt, txt[:300]
        assert "frecuencia a confirmar con receta" in txt
        for fmt, magic in (("docx", b"PK"), ("pdf", b"%PDF")):
            h = page.get_by_role("link", name=fmt.upper() if fmt == "pdf" else "Word (.docx)").get_attribute("href")
            body = page.request.get(BASE + h).body()
            assert body[:len(magic)] == magic, fmt

        # El navegador no guarda datos clínicos.
        storage = page.evaluate("""async () => {
            const dbs = indexedDB.databases ? await indexedDB.databases() : [];
            const keys = [];
            if (self.caches) for (const n of await caches.keys()) {
                for (const r of await (await caches.open(n)).keys()) keys.push(new URL(r.url).pathname);
            }
            return {ls: localStorage.length, ss: sessionStorage.length, dbs: dbs.length, cached: keys};
        }""")
        assert storage["ls"] == 0 and storage["ss"] == 0 and storage["dbs"] == 0, storage
        assert not any(k.startswith("/api/") for k in storage["cached"]), storage

        # Otro profesional no ve la entrevista.
        ctx_b = browser.new_context(**IPHONE)
        pb = ctx_b.new_page()
        pb.goto(BASE)
        pb.get_by_role("button", name="Entrar como Profesional Demo B").click()
        expect(pb.get_by_text("No hay anamnesis con estos filtros.")).to_be_visible()
        ctx_b.close()

        # Computador: transcripción y borrador lado a lado.
        desk = browser.new_context(viewport={"width": 1280, "height": 900}, locale="es-CL")
        pd = desk.new_page()
        pd.goto(BASE)
        pd.get_by_role("button", name="Entrar como Profesional Demo B").click()
        pd.get_by_role("button", name="Nueva entrevista").click()
        expect(pd.get_by_text("Inicia la escucha")).to_be_visible()
        expect(pd.locator(".pane-anamnesis")).to_be_visible()
        shot(pd, "08-computador")
        desk.close()

        assert not errors, errors
        browser.close()
    print("E2E OK: flujo de demostración completo (emulación Chromium tamaño iPhone y computador, no Safari real)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
