"""
E2E del modo sin conexión manual. EMULACIÓN en Chromium con tamaño de iPhone;
no es una prueba en Safari real de iPhone.

Cubre: preparar el dispositivo con frase, escribir un borrador manual,
«Guardado en este dispositivo», contenido cifrado en IndexedDB (sin texto en
claro), recarga sin conexión servida por el service worker, desbloqueo local sin
peticiones al servidor, «Pendiente de sincronizar», sincronización al volver la
conexión («Sincronizado con tu cuenta»), cierre de sesión que conserva los
borradores cifrados, separación entre profesionales del mismo dispositivo y
eliminación en el corte diario aunque no se haya sincronizado.
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
PASS = "frase ficticia de prueba"
SECRET = "DEMO-OFFLINE-SECRETO cefalea ficticia"
NOTICE = "Los borradores guardados solo en este dispositivo se eliminan en el corte diario, aunque no se hayan sincronizado."

RAW_IDB = """async () => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  const names = dbs.map(d => d.name);
  if (!names.includes('aa-offline')) return {names, text: '', records: 0, spaces: 0};
  const db = await new Promise((ok, ko) => { const r = indexedDB.open('aa-offline'); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
  const all = (store) => new Promise((ok) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); });
  const recs = await all('records');
  const spaces = await all('spaces');
  db.close();
  const dec = new TextDecoder('latin1');
  const text = recs.map(r => dec.decode(r.data)).join('|') + JSON.stringify(spaces);
  return {names, text, records: recs.length, spaces: spaces.length};
}"""


def shot(page, name):
    page.screenshot(path=f"{SHOTS}/{name}.png")


def login(page, who="A"):
    page.goto(BASE)
    page.get_by_role("button", name=f"Entrar como Profesional Demo {who}").click()
    expect(page.get_by_role("heading", name="Mis anamnesis")).to_be_visible()


def wait_sw(page):
    page.wait_for_function("""async () => {
      if (!navigator.serviceWorker) return false;
      await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      for (const k of keys) {
        const reqs = await (await caches.open(k)).keys();
        if (reqs.some(r => new URL(r.url).pathname.startsWith('/assets/'))) return true;
      }
      return false;
    }""", timeout=15000)


def unlock(page):
    page.get_by_label("Frase de desbloqueo de este dispositivo").fill(PASS)
    page.get_by_role("button", name="Desbloquear borradores").click()
    expect(page.get_by_role("heading", name="Borradores en este dispositivo")).to_be_visible(timeout=20000)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(**IPHONE)
        page = ctx.new_page()

        # 1. Preparar el dispositivo (con conexión y sesión).
        login(page, "A")
        wait_sw(page)
        expect(page.get_by_text(NOTICE).first).to_be_visible()
        page.get_by_label("Frase de desbloqueo (mínimo 10 caracteres)").fill("corta")
        page.get_by_label("Repite la frase").fill("corta")
        page.get_by_role("button", name="Preparar este dispositivo").click()
        expect(page.get_by_text("al menos 10 caracteres")).to_be_visible()
        page.get_by_label("Frase de desbloqueo (mínimo 10 caracteres)").fill(PASS)
        page.get_by_label("Repite la frase").fill(PASS)
        page.get_by_role("button", name="Preparar este dispositivo").click()
        expect(page.get_by_role("heading", name="Borradores en este dispositivo")).to_be_visible(timeout=20000)
        shot(page, "40-offline-preparado")

        # 2. Sin conexión: escribir un borrador manual.
        ctx.set_offline(True)
        page.get_by_role("button", name="Nueva anamnesis manual").click()
        page.get_by_role("textbox", name="Motivo de consulta").fill(SECRET)
        expect(page.get_by_text("Guardado en este dispositivo", exact=False)).to_be_visible(timeout=5000)
        shot(page, "41-offline-guardado-local")
        page.get_by_role("button", name="Guardar y volver").click()
        expect(page.get_by_text("Pendiente de sincronizar")).to_be_visible(timeout=8000)
        expect(page.get_by_text("Sin conexión: lo que escribas se guarda solo en este dispositivo", exact=False)).to_be_visible()

        # 3. Cifrado en el dispositivo: ni el texto ni el nombre del profesional en claro.
        raw = page.evaluate(RAW_IDB)
        assert raw["names"] == ["aa-offline"], raw["names"]
        assert raw["records"] >= 2 and raw["spaces"] == 1, raw
        for s in ("DEMO-OFFLINE-SECRETO", "cefalea", "Profesional Demo A", "Motivo de consulta", PASS):
            assert s not in raw["text"], f"en claro en IndexedDB: {s}"
        assert page.evaluate("localStorage.length + sessionStorage.length") == 0

        # 4. Recargar SIN conexión: el service worker sirve la app; se desbloquea sin pedir nada al servidor.
        page.reload()
        expect(page.get_by_text("Sin conexión con el servidor", exact=False)).to_be_visible(timeout=15000)
        assert SECRET not in page.evaluate("document.body.innerText"), "bloqueado: no se muestra contenido"
        api_calls = []
        page.on("request", lambda r: api_calls.append(r.url) if "/api/" in r.url else None)
        unlock(page)
        expect(page.get_by_text("Pendiente de sincronizar")).to_be_visible()
        page.get_by_role("button", name="Editar").first.click()
        expect(page.get_by_role("textbox", name="Motivo de consulta")).to_have_value(SECRET)

        other = ctx.new_page()
        other.goto(BASE)
        unlock(other)
        other.get_by_role("button", name="Editar").first.click()
        other_field = other.get_by_role("textbox", name="Motivo de consulta")
        expect(other_field).to_have_value(SECRET)
        page.get_by_role("textbox", name="Motivo de consulta").fill(SECRET + " versión guardada")
        page.get_by_role("button", name="Guardar y volver").click()
        expect(page.get_by_role("heading", name="Borradores en este dispositivo")).to_be_visible()
        other_field.fill("DEMO edición de otra pestaña")
        expect(other.get_by_role("alert")).to_contain_text("Tus cambios siguen abiertos en este editor")
        expect(other_field).to_have_value("DEMO edición de otra pestaña")
        other.get_by_role("button", name="Cargar la versión guardada").click()
        expect(other_field).to_have_value(SECRET + " versión guardada")
        other.close()
        page.get_by_role("button", name="Editar").first.click()
        page.get_by_role("textbox", name="Motivo de consulta").fill(SECRET)
        page.get_by_role("button", name="Guardar y volver").click()
        assert not api_calls, f"desbloquear no debe contactar al servidor: {api_calls}"
        shot(page, "42-offline-recarga-sin-conexion")

        # 5. «Bloquear» olvida la clave.
        page.get_by_role("button", name="Bloquear").click()
        expect(page.get_by_label("Frase de desbloqueo de este dispositivo")).to_be_visible()
        assert SECRET not in page.evaluate("document.body.innerText")

        # 6. Vuelve la conexión: con la sesión del servidor se sincroniza.
        ctx.set_offline(False)
        page.goto(BASE)
        expect(page.get_by_role("heading", name="Mis anamnesis")).to_be_visible(timeout=15000)
        unlock(page)
        expect(page.get_by_text("Sincronizado con tu cuenta")).to_be_visible(timeout=10000)
        raw = page.evaluate(RAW_IDB)
        assert "DEMO-OFFLINE-SECRETO" not in raw["text"]
        page.get_by_role("button", name="Abrir en Mis anamnesis").click()
        expect(page.get_by_text(SECRET).first).to_be_visible(timeout=10000)
        shot(page, "43-offline-sincronizado")

        # 7. Otro borrador sin sincronizar; cerrar sesión lo conserva cifrado.
        page.goto(BASE)
        expect(page.get_by_role("heading", name="Mis anamnesis")).to_be_visible()
        unlock(page)
        ctx.set_offline(True)
        page.get_by_role("button", name="Nueva anamnesis manual").click()
        page.get_by_role("textbox", name="Motivo de consulta").fill("DEMO segundo borrador sin sincronizar")
        expect(page.get_by_text("Guardado en este dispositivo", exact=False)).to_be_visible(timeout=5000)
        page.get_by_role("button", name="Guardar y volver").click()
        page.get_by_role("button", name="Bloquear").click()  # se sale antes de volver la conexión
        ctx.set_offline(False)
        page.goto(BASE)
        expect(page.get_by_role("heading", name="Mis anamnesis")).to_be_visible()
        page.get_by_role("button", name="Cerrar sesión").click()
        expect(page.get_by_text("Los borradores sin conexión siguen cifrados")).to_be_visible()
        assert page.evaluate(RAW_IDB)["spaces"] == 1, "cerrar sesión no elimina los borradores cifrados"
        expect(page.get_by_role("button", name="Borradores sin conexión de este dispositivo")).to_be_visible()

        # 8. Otro profesional en el mismo dispositivo no ve ni abre el espacio de A.
        page.get_by_role("button", name="Entrar como Profesional Demo B").click()
        expect(page.get_by_role("heading", name="Mis anamnesis")).to_be_visible()
        expect(page.get_by_role("button", name="Preparar este dispositivo")).to_be_visible()
        expect(page.get_by_label("Frase de desbloqueo de este dispositivo")).to_have_count(0)
        page.get_by_role("button", name="Cerrar sesión").click()
        expect(page.get_by_text("Cerraste la sesión")).to_be_visible()

        # 9. Corte diario: se eliminan aunque no se hayan sincronizado.
        ctx2 = browser.new_context(**IPHONE)
        pg2 = ctx2.new_page()
        login(pg2, "A")
        pg2.request.post(BASE + "/api/dev/clock", data={"secondsBeforeCutoff": 15}, headers={"Origin": BASE})
        pg2.get_by_label("Frase de desbloqueo (mínimo 10 caracteres)").fill(PASS)
        pg2.get_by_label("Repite la frase").fill(PASS)
        pg2.get_by_role("button", name="Preparar este dispositivo").click()
        expect(pg2.get_by_role("heading", name="Borradores en este dispositivo")).to_be_visible(timeout=20000)
        pg2.context.set_offline(True)  # sin sincronizar
        pg2.get_by_role("button", name="Nueva anamnesis manual").click()
        pg2.get_by_role("textbox", name="Motivo de consulta").fill("DEMO borrador que vence en el corte")
        expect(pg2.get_by_text("Guardado en este dispositivo", exact=False)).to_be_visible(timeout=5000)
        assert pg2.evaluate(RAW_IDB)["spaces"] == 1
        pg2.wait_for_function(
            f"async () => {{ const {{ spaces, records }} = await ({RAW_IDB})(); return spaces === 0 && records === 0; }}",
            timeout=30000, polling=500,
        )
        assert "DEMO borrador que vence" not in pg2.evaluate("document.body.innerText")
        shot(pg2, "44-offline-corte")
        pg2.context.set_offline(False)
        pg2.request.post(BASE + "/api/dev/clock", data={"secondsBeforeCutoff": 999999}, headers={"Origin": BASE})
        ctx2.close()
        ctx.close()
        browser.close()
    print("E2E OK: modo sin conexión manual (emulación Chromium tamaño iPhone, no Safari real)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
