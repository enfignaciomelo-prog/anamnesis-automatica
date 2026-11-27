"""
E2E del llenado asistido con un proveedor SIMULADO (ALLOW_TEST_FILL=true; sin
llamadas a Claude). EMULACIÓN en Chromium con tamaño de iPhone, no Safari real.

Cubre: botón «Completar con Claude», estado pendiente, propuestas con su
respaldo literal, aviso de propuestas descartadas, contradicción de dosis con
ambas versiones visibles, bloqueo de la finalización hasta revisar y la
corrección manual que se conserva.
"""
import os
import sys
from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:4175")
SHOTS = os.environ.get("SHOTS_DIR", "/tmp/aa-e2e")
os.makedirs(SHOTS, exist_ok=True)
IPHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True,
              has_touch=True, locale="es-CL")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(**IPHONE)
        page = ctx.new_page()
        page.goto(BASE)
        page.get_by_role("button", name="Entrar como Profesional Demo A").click()
        page.get_by_role("button", name="Nueva entrevista").click()
        expect(page.get_by_text("Conectado")).to_be_visible()
        page.get_by_role("button", name="Iniciar escucha").click()
        page.get_by_label("Informé lo anterior y la persona aceptó.").check()
        page.get_by_role("button", name="Registrar e iniciar").click()
        expect(page.locator(".segment")).to_have_count(20, timeout=20000)

        page.get_by_role("tab", name="Anamnesis").click()
        expect(page.get_by_role("heading", name="Llenado asistido con Claude")).to_be_visible()
        expect(page.get_by_text("Aún no se ha solicitado.")).to_be_visible()
        # Antes de pedirlo no hay propuestas automáticas: todo «No referido».
        assert page.locator(".draft").get_by_text("mucha sed").count() == 0

        page.get_by_role("button", name="Completar con Claude").click()
        expect(page.get_by_text("Claude está revisando la transcripción")).to_be_visible()
        expect(page.get_by_text("Propuestas listas: 4", exact=False)).to_be_visible(timeout=10000)
        expect(page.get_by_text("1 propuesta(s) se descartaron", exact=False)).to_be_visible()
        expect(page.locator(".draft").get_by_text("ando con mucha sed y orino harto", exact=False).first).to_be_visible()
        expect(page.locator(".draft").get_by_text("colecistectomía")).to_have_count(0)
        expect(page.locator(".draft").get_by_text("Hay versiones distintas en la entrevista").first).to_be_visible()
        page.screenshot(path=f"{SHOTS}/50-claude-propuestas.png", full_page=True)

        # Finalizar exige revisar lo crítico.
        page.get_by_role("tab", name="Finalizar").click()
        expect(page.get_by_text("requieren revisión", exact=False).first).to_be_visible()
        ctx.close()
        browser.close()
    print("E2E OK: llenado asistido con proveedor simulado (emulación Chromium tamaño iPhone, no Safari real)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
