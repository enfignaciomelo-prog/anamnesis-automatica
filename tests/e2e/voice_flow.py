"""AudioWorklet y controles con micrófono de Chromium y un proveedor WebSocket local."""
from playwright.sync_api import expect, sync_playwright

BASE = "http://localhost:4174"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True, args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
        )
        context = browser.new_context(locale="es-CL", permissions=["microphone"])
        page = context.new_page()
        page.goto(BASE)
        page.get_by_role("button", name="Entrar como Profesional Demo A").click()
        page.get_by_role("button", name="Nueva entrevista", exact=False).click()
        page.get_by_role("button", name="Iniciar escucha").click()
        consent = page.get_by_role("dialog")
        expect(consent.get_by_text("Enviaremos el audio a Deepgram", exact=False)).to_be_visible()
        expect(consent.get_by_role("button", name="Registrar e iniciar")).to_be_disabled()
        consent.get_by_label("Informé lo anterior y la persona aceptó.").check()
        consent.get_by_role("button", name="Registrar e iniciar").click()
        expect(page.get_by_text("Me tinca.", exact=True)).to_have_count(1, timeout=15000)

        page.get_by_role("button", name="Pausar", exact=True).click()
        expect(page.get_by_text("Me duele la guata.", exact=True)).to_have_count(1)
        page.get_by_role("button", name="Reanudar").click()
        expect(page.get_by_text("Me tinca.", exact=True)).to_have_count(2)
        page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        expect(page.get_by_role("button", name="Reanudar")).to_be_visible()
        page.get_by_role("button", name="Reanudar").click()
        expect(page.get_by_text("Me tinca.", exact=True)).to_have_count(3)
        page.get_by_role("button", name="Detener", exact=True).click()
        expect(page.get_by_text("Me duele la guata.", exact=True)).to_have_count(2)
        expect(page.get_by_role("button", name="Detener", exact=True)).to_have_count(0)
        browser.close()
        print("E2E OK: micrófono simulado de Chromium, PCM, consentimiento, pausa y reanudación, WebSocket local")


if __name__ == "__main__":
    main()
