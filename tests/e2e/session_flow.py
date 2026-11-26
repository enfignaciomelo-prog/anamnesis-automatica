"""
E2E de sesión y limpieza local. EMULACIÓN en Chromium con tamaño de iPhone;
no es una prueba en Safari real de iPhone.

Cubre: botón Detener, cierre propagado entre pestañas, respuesta tardía que no
restaura datos, «Atrás» sin contenido clínico, almacenamiento vacío, pérdida de
conexión sin falso «Guardado», revalidación al reanudar desde suspensión, aviso
previo al corte y vencimiento en el corte con la pestaña activa.
"""
import os
import sys
import time
from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:4173")
SHOTS = os.environ.get("SHOTS_DIR", "/tmp/aa-e2e")
os.makedirs(SHOTS, exist_ok=True)
IPHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True,
              has_touch=True, locale="es-CL")
TITLE = "Entrevista demo"


def shot(page, name):
    page.screenshot(path=f"{SHOTS}/{name}.png")


def login(page, who="A"):
    page.goto(BASE)
    page.get_by_role("button", name=f"Entrar como Profesional Demo {who}").click()
    expect(page.get_by_role("heading", name="Mis anamnesis")).to_be_visible()


def new_interview(page):
    page.get_by_role("button", name="Nueva entrevista").click()
    expect(page.get_by_text("Conectado")).to_be_visible()


def storage_snapshot(page):
    return page.evaluate("""async () => {
        const dbs = indexedDB.databases ? await indexedDB.databases() : [];
        const keys = [];
        if (self.caches) for (const n of await caches.keys())
            for (const r of await (await caches.open(n)).keys()) keys.push(new URL(r.url).pathname);
        return {ls: localStorage.length, ss: sessionStorage.length, dbs: dbs.length, cached: keys,
                text: document.body.innerText};
    }""")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # 1. Botón Detener: después de detener no llegan más segmentos.
        ctx = browser.new_context(**IPHONE)
        page = ctx.new_page()
        login(page, "B")
        new_interview(page)
        page.get_by_role("button", name="Iniciar escucha").click()
        page.get_by_label("Informé lo anterior y la persona aceptó.").check()
        page.get_by_role("button", name="Registrar e iniciar").click()
        expect(page.locator(".listen-escuchando")).to_be_visible()
        page.get_by_role("button", name="Pausar").click()
        expect(page.locator(".listen-pausada")).to_be_visible()
        page.get_by_role("button", name="Detener").click()
        expect(page.locator(".listen-detenida")).to_be_visible()
        expect(page.get_by_role("button", name="Reanudar")).to_have_count(0)
        expect(page.get_by_role("button", name="Detener")).to_have_count(0)
        n = page.locator(".segment").count()
        time.sleep(2)
        assert page.locator(".segment").count() == n, "no deben llegar segmentos después de Detener"
        assert n < 20, f"se detuvo antes de terminar el guion ({n} segmentos)"
        expect(page.get_by_text("Guardado", exact=False)).to_be_visible()
        shot(page, "31-detenida")

        # 2. Pérdida de conexión: no se muestra «Guardado» falso.
        page.get_by_role("tab", name="Anamnesis").click()
        ctx.set_offline(True)
        page.locator("#field-motivo").get_by_role("button", name="Editar").click()
        page.locator("#field-motivo textarea").fill("Texto ficticio escrito sin conexión")
        time.sleep(2)
        expect(page.get_by_text("Error al guardar el borrador")).to_be_visible()
        expect(page.locator(".save-error")).to_have_text("Error al guardar")
        shot(page, "32-sin-conexion")
        ctx.set_offline(False)
        page.locator("#field-motivo textarea").fill("Texto ficticio escrito con conexión")
        expect(page.get_by_text("Borrador guardado en el servidor")).to_be_visible(timeout=6000)

        # 3. Cierre en una pestaña se propaga a la otra; respuesta tardía no restaura datos.
        page2 = ctx.new_page()
        page2.goto(BASE)
        expect(page2.get_by_role("heading", name="Mis anamnesis")).to_be_visible()
        expect(page2.get_by_text(TITLE).first).to_be_visible()
        # Respuesta tardía: la lista de page2 queda retenida y se entrega DESPUÉS del cierre.
        held = []
        page2.route("**/api/interviews?*", lambda route: held.append(route))
        page2.get_by_label("Estado").select_option("borrador")
        page2.wait_for_timeout(500)
        assert held, "la petición debe quedar retenida"
        page.get_by_role("button", name="Entrevistas").click()
        page.get_by_role("button", name="Cerrar sesión").click()
        expect(page.get_by_text("Cerraste la sesión")).to_be_visible()
        expect(page2.get_by_text("La sesión se cerró en otra pestaña")).to_be_visible(timeout=8000)
        for route in held:
            try:
                route.fulfill(status=200, content_type="application/json",
                              body='[{"id":"x","title":"DATO TARDIO FICTICIO","status":"detenida","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","templateName":"x"}]')
            except Exception:
                pass  # la petición ya fue cancelada por la limpieza
        page2.wait_for_timeout(1500)
        assert "DATO TARDIO" not in page2.evaluate("document.body.innerText"), "una respuesta tardía no debe repoblar datos"
        for pg in (page, page2):
            snap = storage_snapshot(pg)
            assert TITLE not in snap["text"], "no debe quedar contenido clínico visible"
            assert snap["ls"] == 0 and snap["ss"] == 0 and snap["dbs"] == 0, snap
            assert not any(k.startswith("/api/") for k in snap["cached"]), snap
        shot(page2, "33-cierre-otra-pestana")

        # 4. «Atrás» no vuelve a mostrar contenido clínico.
        page.go_back()
        time.sleep(1)
        assert TITLE not in page.evaluate("document.body ? document.body.innerText : ''")
        ctx.close()

        # 5. Reanudar tras suspensión con la sesión ya vencida: se limpia antes de mostrar.
        ctx = browser.new_context(**IPHONE)
        page = ctx.new_page()
        login(page, "B")
        expect(page.get_by_text(TITLE).first).to_be_visible()
        page.request.post(BASE + "/api/logout", headers={"Origin": BASE})  # vence en el servidor
        page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}))")
        expect(page.get_by_text("Tu sesión ya no es válida")).to_be_visible(timeout=8000)
        assert TITLE not in page.evaluate("document.body.innerText")
        ctx.close()

        # 6. Aviso previo y vencimiento en el corte con la pestaña activa.
        ctx = browser.new_context(**IPHONE)
        page = ctx.new_page()
        login(page, "A")
        new_interview(page)
        page.request.post(BASE + "/api/dev/clock", data={"secondsBeforeCutoff": 240}, headers={"Origin": BASE})
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.get_by_text("A las 23:59", exact=False)).to_be_visible(timeout=8000)
        shot(page, "34-aviso-corte")
        page.request.post(BASE + "/api/dev/clock", data={"secondsBeforeCutoff": 3}, headers={"Origin": BASE})
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.get_by_text("La sesión venció en el corte diario", exact=False)).to_be_visible(timeout=15000)
        assert "Conectado" not in page.evaluate("document.body.innerText")
        # El siguiente acceso pertenece al período siguiente: no hay bucle de cierre.
        page.request.post(BASE + "/api/dev/clock", data={"secondsBeforeCutoff": 999999}, headers={"Origin": BASE})
        page.get_by_role("button", name="Entrar como Profesional Demo A").click()
        expect(page.get_by_role("heading", name="Mis anamnesis")).to_be_visible()
        time.sleep(2)
        expect(page.get_by_role("heading", name="Mis anamnesis")).to_be_visible()
        shot(page, "35-tras-corte")
        ctx.close()

        browser.close()
    print("E2E OK: sesión, limpieza y corte diario (emulación Chromium tamaño iPhone, no Safari real)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
