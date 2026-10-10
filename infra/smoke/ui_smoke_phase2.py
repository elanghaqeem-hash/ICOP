"""
UI smoke Phase 2 (mobile 390x844): Tender Center → RKS upload & ekstraksi → compliance → Bid/No-Bid → proposal generator.
Pakai: python3 ui_smoke_phase2.py <base_url> <seed_password> <out_dir> <rks_pdf_path>
"""
import re
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE, SEED_PW, OUT, RKS = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4]
NEW_PW = "Ui!Smoke-Passw0rd"
OUT.mkdir(parents=True, exist_ok=True)
results = []


def shot(page, name):
    page.wait_for_timeout(400)
    w = page.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
    results.append((f"no horizontal overflow: {name}", w[0] <= w[1] + 1, f"{w[0]} vs {w[1]}"))
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)


def login(page, email):
    page.goto(f"{BASE}/login")
    page.fill("input[type=email]", email)
    page.fill("input[type=password]", NEW_PW)
    page.click("button:has-text('Masuk')")
    page.wait_for_timeout(800)
    if "/login" in page.url:
        page.fill("input[type=password]", SEED_PW)
        page.click("button:has-text('Masuk')")
        page.wait_for_url(re.compile("change-password"))
        pw = page.locator("input[type=password]")
        pw.nth(0).fill(SEED_PW); pw.nth(1).fill(NEW_PW); pw.nth(2).fill(NEW_PW)
        page.click("button:has-text('Simpan password')")
    page.wait_for_url(re.compile(r"/(portal)?$"))


def logout(page):
    page.evaluate("() => sessionStorage.clear()")


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    stamp = time.strftime("%H%M%S")

    login(page, "tender@defendit360.com")
    page.goto(f"{BASE}/tenders")
    page.click("button:has-text('+ Tender')")
    form = page.locator("form")
    form.locator("input").nth(0).fill(f"Jasa Managed SOC dan Penetration Test {stamp}")
    form.locator("input").nth(1).fill("Badan Siber Demo Provinsi")
    form.locator("select").nth(0).select_option(index=1)
    form.locator("input[type=number]").fill("2500000000")
    form.locator("input[type=datetime-local]").fill("2026-12-01T10:00")
    form.locator("button:has-text('Simpan')").click()
    page.wait_for_timeout(700)
    page.click(f"text=Jasa Managed SOC dan Penetration Test {stamp}")
    page.wait_for_url(re.compile("/tenders/"))
    tender_url = page.url
    page.click("button.btn:has-text('SCREENING')")
    page.wait_for_timeout(500)
    page.click("button.btn:has-text('REGISTERED')")
    page.wait_for_selector("text=opportunity")
    shot(page, "p2-01-tender-overview")
    page.click(".tabs button:has-text('Dokumen')")
    page.set_input_files("input[type=file]", RKS)
    page.click("button:has-text('Unggah')")
    page.wait_for_selector("text=DONE")
    page.uncheck("text=+ AI")
    page.click("button:has-text('Ekstrak persyaratan')")
    page.wait_for_selector("text=persyaratan baru")
    shot(page, "p2-02-documents-extracted")
    page.click(".tabs button:has-text('Persyaratan')")
    page.wait_for_selector("text=RKS-001")
    count = page.locator(".list-item .mono").count()
    results.append(("10 requirements extracted from RKS", count == 10, str(count)))
    page.locator("button:has-text('Review')").first.click()
    page.locator("label:has-text('Status') + select").select_option("COMPLY")
    page.locator("label:has-text('Referensi bukti') + input").fill("NIB-2026-001")
    page.click("button.btn.sm:has-text('Simpan')")
    page.wait_for_timeout(600)
    shot(page, "p2-03-compliance-matrix")
    page.click(".tabs button:has-text('Bid/No-Bid')")
    for btn in page.locator(".field .row").all():
        btn.locator("button:has-text('4')").click()
    page.wait_for_selector("text=GO")
    shot(page, "p2-04-bid-scorecard")
    page.click("button:has-text('Ajukan untuk approval')")
    page.wait_for_selector("text=IN APPROVAL")
    logout(page)

    login(page, "presales@defendit360.com")
    page.goto(tender_url)
    page.click(".tabs button:has-text('Proposal')")
    page.click("button:has-text('Generate proposal teknis dari data')")
    page.wait_for_url(re.compile("/proposals/"))
    page.wait_for_selector("text=Matriks Kepatuhan Teknis")
    flagged = page.locator("text=[PERLU DILENGKAPI]").count()
    results.append(("proposal marks missing info instead of inventing it", flagged > 0, str(flagged)))
    shot(page, "p2-05-proposal-editor")
    b.close()

    results.append(("no client-side JS errors", not errors, "; ".join(errors)[:300]))
    for name, ok, info in results:
        print(("PASS " if ok else "FAIL ") + name + (f" ({info})" if info and not ok else ""))
    sys.exit(1 if any(not r[1] for r in results) else 0)
