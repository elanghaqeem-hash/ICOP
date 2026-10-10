"""
UI smoke test (mobile 390x844) — menjalankan alur Phase 1 lewat antarmuka nyata
melawan API + PostgreSQL yang berjalan. Screenshot disimpan ke OUT_DIR.

Pakai: python3 ui_smoke.py <base_url> <seed_password> <out_dir>
"""
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE, SEED_PW, OUT = sys.argv[1], sys.argv[2], Path(sys.argv[3])
NEW_PW = "Ui!Smoke-Passw0rd"
OUT.mkdir(parents=True, exist_ok=True)
results = []


def check_overflow(page, name):
    w = page.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
    ok = w[0] <= w[1] + 1
    results.append((f"no horizontal overflow: {name}", ok, f"{w[0]}px vs {w[1]}px"))


def shot(page, name):
    page.wait_for_timeout(400)
    check_overflow(page, name)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)


def login(page, email):
    page.goto(f"{BASE}/login")
    page.fill("input[type=email]", email)
    page.fill("input[type=password]", NEW_PW)
    page.click("button:has-text('Masuk')")
    page.wait_for_timeout(800)
    if "/login" in page.url:  # first login → seed password
        page.fill("input[type=password]", SEED_PW)
        page.click("button:has-text('Masuk')")
        page.wait_for_url(re.compile("change-password"))
        pw = page.locator("input[type=password]")
        pw.nth(0).fill(SEED_PW)
        pw.nth(1).fill(NEW_PW)
        pw.nth(2).fill(NEW_PW)
        page.click("button:has-text('Simpan password')")
    page.wait_for_url(re.compile(r"/(portal)?$"))


def logout(page):
    page.evaluate("() => sessionStorage.clear()")


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # 1. Sales: customer + opportunity
    login(page, "sales@defendit360.com")
    expect(page.locator("h1")).to_contain_text("Halo")
    shot(page, "01-dashboard-sales")
    page.goto(f"{BASE}/customers")
    page.click("button:has-text('+ Customer')")
    CUST = f"PT Bank Demo Sejahtera {__import__('time').strftime('%H%M%S')}"
    page.locator("form input").first.fill(CUST)
    page.click("form button:has-text('Simpan')")
    page.click(f"text={CUST}")
    page.wait_for_url(re.compile("/customers/"))
    page.click("button:has-text('+ Opportunity')")
    page.locator("form input").first.fill("VAPT Mobile Banking 2026")
    page.locator("form input[type=number]").fill("250000000")
    page.click("form button:has-text('Simpan')")
    page.wait_for_timeout(600)
    shot(page, "02-customer-360")
    page.click("text=VAPT Mobile Banking 2026")
    page.wait_for_url(re.compile("/opportunities/"))
    opp_url = page.url
    page.click("button:has-text('QUALIFIED')")
    page.wait_for_timeout(500)
    page.click("button.btn:has-text('SCOPING')")
    page.wait_for_timeout(500)
    shot(page, "03-deal360-overview")
    logout(page)

    # 2. Pre-sales: scoping → review → pricing → quotation
    login(page, "presales@defendit360.com")
    page.goto(opp_url)
    page.click(".tabs button:has-text('Scoping')")
    page.click("button:has-text('+ Assessment baru')")
    page.click("button:has-text('+ Tambah web app')")
    page.locator("details").first.locator("input").first.fill("Internet Banking")
    page.fill("input[placeholder^='mis. Senin']", "Senin-Jumat 20:00-04:00")
    page.click("button:has-text('Simpan & hitung effort')")
    page.wait_for_selector("text=MD teknis")
    page.click("button:has-text('Sahkan (engineer review)')")
    page.wait_for_selector("text=REVIEWED")
    shot(page, "04-scoping-reviewed")
    page.click(".tabs button:has-text('Pricing')")
    page.wait_for_selector("text=Harga jual (ex-PPN)")
    shot(page, "05-pricing-engine")
    page.click("button:has-text('Simpan scenario')")
    page.wait_for_selector("text=Scenario tersimpan")
    page.click("button:has-text('Buat quotation')")
    page.wait_for_url(re.compile("/quotations/"))
    q_url = page.url
    shot(page, "06-quotation-draft")
    logout(page)

    # 3. Sales submits with 10% discount → needs Manager + VP
    login(page, "sales@defendit360.com")
    page.goto(q_url)
    page.click("button:has-text('Edit')")
    page.locator("label:has-text('Diskon') + input").fill("10")
    page.click("button:has-text('Simpan')")
    page.wait_for_timeout(600)
    page.click("button:has-text('Ajukan approval')")
    page.wait_for_selector("text=IN APPROVAL")
    logout(page)

    for who in ["salesmanager@defendit360.com", "vp@defendit360.com"]:
        login(page, who)
        page.goto(f"{BASE}/approvals")
        page.wait_for_selector(".list-item")
        if who.startswith("vp"):
            shot(page, "07-decision-center-mobile")
        page.locator(".list-item").first.click()
        page.wait_for_selector("button:has-text('Setujui')")
        if who.startswith("vp"):
            shot(page, "08-approval-detail")
        page.click("button:has-text('Setujui')")
        page.wait_for_timeout(800)
        logout(page)

    # 4. Sales issues and previews the offer letter
    login(page, "sales@defendit360.com")
    page.goto(q_url)
    page.click("button:has-text('Terbitkan')")
    page.wait_for_selector("text=ISSUED")
    page.click("button:has-text('Lihat surat penawaran')")
    page.wait_for_selector("iframe")
    shot(page, "09-quotation-issued")
    frame_html = page.frame_locator("iframe").locator("body").inner_text()
    results.append(("offer letter has no internal cost data", not re.search(r"(?i)biaya internal|floor|margin", frame_html), ""))

    # desktop view of dashboard
    page.set_viewport_size({"width": 1366, "height": 900})
    page.goto(f"{BASE}/")
    page.wait_for_selector(".kpi")
    page.screenshot(path=str(OUT / "10-dashboard-desktop.png"))
    b.close()

    results.append(("no client-side JS errors", not errors, "; ".join(errors)[:300]))
    failed = [r for r in results if not r[1]]
    for name, ok, info in results:
        print(("PASS " if ok else "FAIL ") + name + (f" ({info})" if info and not ok else ""))
    sys.exit(1 if failed else 0)
