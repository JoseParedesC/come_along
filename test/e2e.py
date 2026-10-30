"""E2E de interfaz con Playwright (opcional): python3 test/e2e.py
Variables: SHOTS_DIR (carpeta para capturas), BROWSERS (chromium,firefox,webkit).
Recorre login -> /admin -> /cumplimentado?t= -> /company?t= con reglas v2."""
import os, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = os.environ.get("E2E_PORT", "3777")
BASE = f"http://127.0.0.1:{PORT}"
PASS = "clave-e2e-segura-1"
SHOTS = os.environ.get("SHOTS_DIR")
BROWSERS = os.environ.get("BROWSERS", "chromium").split(",")

tmp = tempfile.mkdtemp()
srv = subprocess.Popen(["node", "server.js"], cwd=ROOT,
                       env={**os.environ, "PORT": PORT, "DB_PATH": f"{tmp}/e2e.db", "ADMIN_PASSWORD": PASS,
                            "RATE_LIMIT": "off", "BACKUP_INTERVAL_HOURS": "0"},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def digits(s): return int(re.sub(r"[^\d]", "", s))

def run(p, name, desktop):
    b = getattr(p, name).launch()
    vp = {"width": 1280, "height": 900} if desktop else {"width": 390, "height": 844}
    ctx = b.new_context(viewport=vp, locale="es-CO", accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "401" not in m.text else None)  # el 401 es la contraseña incorrecta de la prueba
    page.on("dialog", lambda d: d.accept())
    shot = lambda n: page.screenshot(path=f"{SHOTS}/{name}-{'d' if desktop else 'm'}-{n}.png", full_page=True) if SHOTS else None
    tag = f"{name}-{'escritorio' if desktop else 'movil'}"
    acct = f"Cena {tag}"

    # Sin sesión: /admin manda al login; contraseña incorrecta falla; correcta entra
    page.goto(BASE + "/admin")
    expect(page).to_have_url(re.compile(r"/admin/login$"))
    page.fill("#pw", "incorrecta"); page.get_by_role("button", name="Entrar").click()
    expect(page.locator("#toast")).to_contain_text("incorrecta")
    page.fill("#pw", PASS); page.get_by_role("button", name="Entrar").click()
    page.wait_for_url(re.compile(r"/admin"))
    page.get_by_role("button", name="Nueva cuenta", exact=True).click()   # la BD se comparte entre corridas
    expect(page.get_by_role("heading", name="Nueva cuenta")).to_be_visible()

    # 1) Admin registra la cuenta (propina manual, exentos, invitados, pagadores)
    page.fill("#ev-name", acct)
    page.fill("#ev-payers", "3")
    page.get_by_role("button", name="Agregar", exact=True).nth(0).click()
    page.locator('input[aria-label^="Exentos"]').fill("Laura")
    page.get_by_role("button", name="Agregar", exact=True).nth(1).click()
    page.locator('input[aria-label^="Invitados"]').fill("Pedro")
    def fill_row(i, n, price, qty, tip=False):
        r = page.locator(".rows .row").nth(i)
        r.locator("input").nth(0).fill(n); r.locator("input").nth(1).fill(str(price)); r.locator("input").nth(2).fill(str(qty))
        if tip: r.locator('input[type="checkbox"]').check()
    fill_row(0, "Menú", 5000, 20)
    page.get_by_role("button", name="Agregar ítem").click(); fill_row(1, "Propina", 12000, 1, tip=True)
    body = page.inner_text("body")
    assert "porcentaje" not in body.lower().replace("no hay porcentaje automático", ""), "no debe haber campo de porcentaje"
    assert not page.locator('input[aria-label*="%"]').count()
    expect(page.locator("dl.kv").first).to_contain_text("5")          # total de personas = 3+1+1
    expect(page.locator("dl.kv").nth(1)).to_contain_text("112.000")    # total de la cuenta
    shot("admin-form")
    page.get_by_role("button", name="Guardar y habilitar").click()
    expect(page.get_by_text("Esperando que exentos e invitados")).to_be_visible()
    links = [t.strip() for t in page.locator(".linkrow code").all_inner_texts()]
    honoree_url, company_url = links[0], links[1]
    assert "/cumplimentado?t=" in honoree_url and "/company?t=" in company_url

    # Sin token no se entra
    page.goto(BASE + "/company"); expect(page.get_by_role("heading", name="Falta el enlace")).to_be_visible()

    # 2) Exentos e invitados: sin precios ni propina
    page.goto(honoree_url)
    page.select_option("#who", label="Laura (exento)")
    txt = page.inner_text("body")
    assert "$" not in txt and "propina" not in txt.lower(), txt
    for _ in range(3): page.get_by_role("button", name="Agregar uno: Menú").click()
    shot("honoree")
    page.get_by_role("button", name="Confirmar mi consumo").click()
    page.select_option("#who", label="Pedro (invitado)")
    for _ in range(2): page.get_by_role("button", name="Agregar uno: Menú").click()
    page.get_by_role("button", name="Confirmar mi consumo").click()
    expect(page.get_by_role("heading", name="Consumos registrados")).to_be_visible()

    # 3) Participante: ver total (37.400), nombre, guardar
    page.goto(company_url)
    expect(page.get_by_text("Quedan 15")).to_be_visible()
    for _ in range(5): page.get_by_role("button", name="Agregar uno: Menú").click()
    page.get_by_role("button", name="Ver total").click()
    expect(page.locator(".ticket .total .amount")).to_be_visible()
    assert digits(page.inner_text(".ticket .total .amount")) == 37400
    t = page.inner_text(".ticket")
    assert "propina" in t.lower() and "exentos e invitados" in t.lower()
    shot("company-quote")
    page.get_by_role("button", name="Agregar uno: Menú").click()      # cambiar selección invalida el total
    expect(page.locator(".ticket")).to_have_count(0)
    page.get_by_role("button", name="Quitar uno: Menú").click()
    page.get_by_role("button", name="Ver total").click()
    page.fill("#guest-name", "Ana Prueba")
    page.get_by_role("button", name="Guardar mi cuenta").click()
    expect(page.get_by_role("heading", name="Gracias, Ana Prueba")).to_be_visible()
    shot("company-saved")

    # 3b) Disponibilidad en vivo: otra persona toma unidades mientras alguien elige
    a = ctx.new_page(); a.goto(company_url)
    expect(a.get_by_text("Quedan 10")).to_be_visible()
    for _ in range(3): a.get_by_role("button", name="Agregar uno: Menú").click()
    b2 = ctx.new_page(); b2.goto(company_url)
    for _ in range(9): b2.get_by_role("button", name="Agregar uno: Menú").click()
    b2.get_by_role("button", name="Ver total").click(); b2.fill("#guest-name", "Beto Prueba")
    b2.get_by_role("button", name="Guardar mi cuenta").click()
    expect(b2.get_by_role("heading", name="Gracias, Beto Prueba")).to_be_visible()
    expect(a.get_by_text("Quedan 1", exact=True)).to_be_visible(timeout=15000)   # sondeo cada 8 s
    assert a.locator('input[type="number"]').input_value() == "1", "selección recortada al nuevo tope"
    a.close(); b2.close()

    # 4) Admin: tabla, marcar pago, exportar CSV
    page.goto(BASE + f"/admin")
    expect(page.get_by_role("cell", name=re.compile("^Ana Prueba")).first).to_be_visible()
    page.get_by_role("checkbox", name="Pagado: Ana Prueba").check()
    expect(page.locator(".card .k", has_text=re.compile(r"^Pagado$")).locator("xpath=..")).to_contain_text("37.400")
    with page.expect_download() as d:
        page.get_by_role("link", name="Exportar CSV").click()
    assert d.value.suggested_filename.endswith(".csv")
    shot("admin-summary")
    assert not errors, errors
    b.close()
    print(f"E2E UI OK · {tag}")

try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + "/health"); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as p:
        for name in BROWSERS:
            try:
                getattr(p, name).launch().close()
            except Exception as e:
                print(f"(omitido {name}: no disponible: {str(e).splitlines()[0][:80]})"); continue
            run(p, name, desktop=False)
            run(p, name, desktop=True)
finally:
    srv.terminate()
