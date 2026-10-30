"""E2E de interfaz con Playwright (opcional): python3 test/e2e.py
Arranca el servidor con una BD temporal y recorre /admin -> /cumplimentado -> /company."""
import os, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = "3777"
BASE = f"http://127.0.0.1:{PORT}"
SHOTS = os.environ.get("SHOTS_DIR")
tmp = tempfile.mkdtemp()
srv = subprocess.Popen(["node", "server.js"], cwd=ROOT,
                       env={**os.environ, "PORT": PORT, "DB_PATH": f"{tmp}/e2e.db"},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/api/config"); break
        except Exception:
            time.sleep(0.1)

    def digits(s): return int(re.sub(r"[^\d]", "", s))

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, locale="es-CO")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("dialog", lambda d: d.accept())

        # 1) Admin registra la cuenta
        page.goto(BASE + "/admin")
        page.fill("#ev-name", "Cena de prueba")
        def fill_row(i, name, price, qty):
            row = page.locator(".rows .row").nth(i)
            row.locator("input").nth(0).fill(name)
            row.locator("input").nth(1).fill(str(price))
            row.locator("input").nth(2).fill(str(qty))
        fill_row(0, "Pizza", 20000, 3)
        page.get_by_role("button", name="Agregar ítem").click(); fill_row(1, "Cerveza", 5000, 6)
        page.get_by_role("button", name="Agregar ítem").click(); fill_row(2, "Postre", 10000, 2)
        expect(page.locator("dl.kv")).to_contain_text("121.000")
        if SHOTS: page.screenshot(path=f"{SHOTS}/admin-form.png", full_page=True)
        page.get_by_role("button", name="Guardar y habilitar al cumplimentado").click()
        expect(page.get_by_text("Esperando que el cumplimentado")).to_be_visible()

        # 2) Cumplimentado (sin precios ni propina)
        page.goto(BASE + "/cumplimentado")
        expect(page.get_by_role("heading", name="Cena de prueba")).to_be_visible()
        body = page.inner_text("body")
        assert "$" not in body and "propina" not in body.lower(), body
        page.get_by_role("button", name="Agregar uno: Pizza").click()
        for _ in range(2): page.get_by_role("button", name="Agregar uno: Cerveza").click()
        if SHOTS: page.screenshot(path=f"{SHOTS}/honoree.png", full_page=True)
        page.get_by_role("button", name="Confirmar mi consumo").click()
        expect(page.get_by_role("heading", name="Consumo registrado")).to_be_visible()

        # 3) Invitado: ver total, nombre, guardar
        page.goto(BASE + "/company")
        for _ in range(2): page.get_by_role("button", name="Agregar uno: Pizza").click()
        for _ in range(2): page.get_by_role("button", name="Agregar uno: Cerveza").click()
        page.get_by_role("button", name="Ver total").click()
        expect(page.locator(".ticket .total .amount")).to_be_visible()
        assert digits(page.inner_text(".ticket .total .amount")) == 75625
        if SHOTS: page.screenshot(path=f"{SHOTS}/company-quote.png", full_page=True)
        # cambiar la selección invalida el total y oculta el guardado
        page.get_by_role("button", name="Agregar uno: Postre").click()
        expect(page.locator(".ticket")).to_have_count(0)
        page.get_by_role("button", name="Quitar uno: Postre").click()
        page.get_by_role("button", name="Ver total").click()
        page.fill("#guest-name", "Ana Prueba")
        page.get_by_role("button", name="Guardar mi cuenta").click()
        expect(page.get_by_role("heading", name="Gracias, Ana Prueba")).to_be_visible()
        if SHOTS: page.screenshot(path=f"{SHOTS}/company-saved.png", full_page=True)

        # 4) Admin ve el registro
        page.goto(BASE + "/admin")
        expect(page.get_by_role("cell", name="Ana Prueba")).to_be_visible()
        if SHOTS: page.screenshot(path=f"{SHOTS}/admin-summary.png", full_page=True)
        assert not errors, errors
        b.close()
    print("E2E UI OK")
finally:
    srv.terminate()
