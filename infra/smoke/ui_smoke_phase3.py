"""
UI smoke Phase 2b + 3 (mobile 390x844):
AI key form & failover order & feature activation -> Document Center (OCR scan) ->
quotation ACCEPTED -> Buat kontrak FlexGuard -> legal review -> DoA -> otorisasi internal ->
portal unggah TTD -> verifikasi legal -> aktivasi -> proyek handover/kickoff -> wallet ->
portal service request -> estimasi -> approval -> customer approve (reserve).

Pakai: python3 ui_smoke_phase3.py <base_url> <seed_password> <out_dir> <scan_pdf> <signed_pdf> <customer_email>
Prasyarat: user customer_user <customer_email> (password = seed, tanpa wajib ganti) untuk customer 'PT Bank Wallet UI'.
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE, SEED_PW, OUT, SCAN, SIGNED, CUST = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6]
NEW_PW = "Ui!Smoke-Passw0rd"
OUT.mkdir(parents=True, exist_ok=True)
results = []
tokens = {}


def check(name, ok, info=""):
    results.append((name, bool(ok), info))


def http(method, path, token=None, body=None, idem=None):
    h = {"content-type": "application/json"}
    if token: h["authorization"] = f"Bearer {token}"
    if idem: h["idempotency-key"] = idem
    req = urllib.request.Request(BASE + path, method=method, headers=h, data=json.dumps(body or {}).encode() if method != "GET" else None)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def tok(email):
    if email in tokens: return tokens[email]
    s, b = http("POST", "/api/v1/auth/login", body={"email": email, "password": NEW_PW})
    if s != 200:
        s, b = http("POST", "/api/v1/auth/login", body={"email": email, "password": SEED_PW})
        assert s == 200, (email, b)
        if b["user"].get("forcePasswordChange"):
            s, b = http("POST", "/api/v1/auth/change-password", b["token"], {"currentPassword": SEED_PW, "newPassword": NEW_PW})
            assert s == 200, b
    tokens[email] = b["token"]
    return b["token"]


def shot(page, name):
    page.wait_for_timeout(500)
    w = page.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
    check(f"no horizontal overflow: {name}", w[0] <= w[1] + 1, f"{w[0]} vs {w[1]}")
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)


def ui_login(page, email):
    page.evaluate("() => sessionStorage.clear()") if page.url.startswith(BASE) else None
    tok(email)  # memastikan password sudah diganti
    page.goto(f"{BASE}/login")
    page.fill("input[type=email]", email)
    page.fill("input[type=password]", NEW_PW if email != CUST else SEED_PW)
    page.click("button:has-text('Masuk')")
    page.wait_for_url(re.compile(r"/(portal)?$"))


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    stamp = time.strftime("%H%M%S")

    # ── A. Admin: API key AI, urutan failover, aktivasi fitur ──
    ui_login(page, "companyadmin@defendit360.com")
    page.goto(f"{BASE}/settings")
    page.wait_for_selector("text=Provider AI & API key")
    first = page.locator("[data-provider]").first.get_attribute("data-provider")
    groq = page.locator("[data-provider=groq]")
    groq.locator("input[type=password]").fill("gsk_demo_" + "x" * 32)
    groq.locator("button:has-text('Simpan key')").last.click()
    page.wait_for_selector("text=tersimpan")
    check("API key tersimpan & ter-masking", page.locator("[data-provider=groq] b.mono").count() == 1)
    page.locator("[data-provider]").first.locator("button[aria-label=Turunkan]").click()
    page.click("button:has-text('Simpan urutan failover')")
    page.wait_for_selector("text=Urutan failover disimpan")
    check("urutan failover tersimpan", page.locator("[data-provider]").nth(1).get_attribute("data-provider") == first)
    page.locator("label.check:has-text('Draft pembuka surat penawaran')").locator("input").uncheck()
    page.click("button:has-text('Simpan aktivasi')")
    page.wait_for_selector("text=Aktivasi fitur AI disimpan")
    s, feats = http("GET", "/api/v1/ai/features", tok("companyadmin@defendit360.com"))
    check("fitur quotation_cover nonaktif di server", any(f["feature"] == "quotation_cover" and not f["enabled"] for f in feats["items"]))
    shot(page, "p3-01-ai-settings")

    # ── B. Document Center: OCR scan ──
    ui_login(page, "presales@defendit360.com")
    page.goto(f"{BASE}/documents")
    page.set_input_files("input[type=file]", SCAN)
    page.fill("input >> nth=1", f"KAK hasil scan {stamp}")
    page.click("button:has-text('Unggah & proses')")
    page.wait_for_selector(f"text=KAK hasil scan {stamp}")
    page.click(f"text=KAK hasil scan {stamp}")
    page.wait_for_url(re.compile("/documents/"))
    for _ in range(60):
        if page.locator(".badge:has-text('READY')").count(): break
        page.wait_for_timeout(2000); page.reload()
    check("OCR selesai (READY)", page.locator(".badge:has-text('READY')").count() > 0)
    check("teks OCR terbaca (NPWP)", "NPWP" in page.content())
    shot(page, "p3-02-document-ocr")

    # ── C. Quotation ACCEPTED (API) ──
    sales = tok("sales@defendit360.com")
    s, cust = http("GET", "/api/v1/customers?q=Wallet%20UI", sales)
    cid = cust["items"][0]["id"]
    s, o = http("POST", "/api/v1/opportunities", sales, {"customerId": cid, "name": f"FlexGuard 162 token {stamp}", "serviceCategory": "VAPT", "amountEstimate": 243000000})
    s, q = http("POST", "/api/v1/quotations", sales, {"opportunityId": o["id"], "title": f"FlexGuard 162 token {stamp}", "lines": [{"description": "FlexGuard token", "qty": 162, "unit": "token", "unitPrice": 1500000}]})
    s, sub = http("POST", f"/api/v1/quotations/{q['id']}/submit", sales, idem=f"s{stamp}")
    for st in sub["steps"]:
        who = {1: "salesmanager", 2: "vp", 3: "direktur"}[st["level"]]
        http("POST", f"/api/v1/approvals/{sub['approvalRequestId']}/decide", tok(f"{who}@defendit360.com"), {"decision": "APPROVE"})
    http("POST", f"/api/v1/quotations/{q['id']}/issue", sales, idem=f"i{stamp}")
    http("POST", f"/api/v1/quotations/{q['id']}/mark-sent", sales, {"channel": "portal"}, idem=f"m{stamp}")
    s, r = http("POST", f"/api/v1/portal/quotations/{q['id']}/respond", tok(CUST), {"response": "ACCEPT", "acknowledgement": True})
    check("quotation ACCEPTED via portal", s == 200, r)

    # ── D. Sales: Buat kontrak FlexGuard dari quotation ──
    ui_login(page, "sales@defendit360.com")
    page.goto(f"{BASE}/quotations/{q['id']}")
    page.click("button:has-text('Buat kontrak')")
    form = page.locator(".card:has(h2:has-text('Buat kontrak'))")
    form.locator("select").first.select_option("FLEXGUARD")
    form.locator("input[type=number]").nth(0).fill("162")
    form.locator("input[type=number]").nth(1).fill("1500000")
    page.click("button:has-text('Buat draft kontrak')")
    page.wait_for_url(re.compile("/contracts/"))
    contract_url = page.url
    contract_id = contract_url.rsplit("/", 1)[1]
    page.click("button:has-text('Ajukan ke Legal')")
    page.wait_for_selector(".badge:has-text('LEGAL REVIEW')")
    shot(page, "p3-03-contract-draft")

    # ── E. Legal review (checklist 10 item) ──
    ui_login(page, "legal@defendit360.com")
    page.goto(contract_url)
    page.wait_for_selector("text=Checklist legal")
    for cb in page.locator(".card:has(h2:has-text('Checklist legal')) input[type=checkbox]").all(): cb.check()
    page.click("button:has-text('Setujui & ajukan approval')")
    page.wait_for_selector("text=diajukan ke approval level")
    shot(page, "p3-04-legal-review")
    s, det = http("GET", f"/api/v1/contracts/{contract_id}", sales)
    ar = det["approvals"][0]
    check("DoA kontrak di bawah floor → level 3 (Direktur)", ar["requiredLevel"] == 3, ar)
    for who in ["salesmanager", "vp", "direktur"]:
        http("POST", f"/api/v1/approvals/{ar['id']}/decide", tok(f"{who}@defendit360.com"), {"decision": "APPROVE"})

    # ── F. Otorisasi internal oleh Direktur ──
    ui_login(page, "direktur@defendit360.com")
    page.goto(contract_url)
    page.wait_for_selector("text=Otorisasi internal")
    page.fill("input[placeholder='Direktur Utama']", "Direktur Utama")
    page.click("button:has-text('Otorisasi')")
    page.wait_for_selector("text=INTERNAL_AUTHORIZATION")

    # ── G. Customer: unggah kontrak bertanda tangan di portal ──
    ui_login(page, CUST)
    page.goto(f"{BASE}/portal/contracts")
    page.click("a.list-item >> nth=0")
    page.wait_for_selector("text=Unggah kontrak bertanda tangan")
    page.locator("input").nth(0).fill("Bpk. Direktur Bank")
    page.locator("input").nth(1).fill("Direktur")
    page.set_input_files("input[type=file]", SIGNED)
    page.click("button:has-text('Unggah')")
    page.wait_for_selector("text=sedang diverifikasi")
    shot(page, "p3-05-portal-contract-signed")

    # ── H. Legal verifikasi, Sales aktivasi ──
    ui_login(page, "legal@defendit360.com")
    page.goto(contract_url)
    page.fill("input[placeholder^='Cocok dengan versi final']", "Tanda tangan & materai sesuai versi final")
    page.click("button:has-text('Verifikasi')")
    page.wait_for_timeout(800)
    ui_login(page, "sales@defendit360.com")
    page.goto(contract_url)
    page.click("button:has-text('Aktifkan kontrak')")
    page.wait_for_selector("text=Kontrak aktif")
    check("kontrak ACTIVE", page.locator(".badge:has-text('ACTIVE')").count() > 0)
    shot(page, "p3-06-contract-active")
    s, det = http("GET", f"/api/v1/contracts/{contract_id}", sales)
    project_id, wallet_id = det["project"]["id"], det["wallet"]["id"]
    check("wallet 162 token", float(det["wallet"]["creditedTokens"]) == 162, det["wallet"])

    # ── I. PM: handover & kickoff ──
    ui_login(page, "pm@defendit360.com")
    page.goto(f"{BASE}/projects/{project_id}")
    page.wait_for_selector("text=Checklist handover")
    page.select_option("select[aria-label='Pilih PM']", label="Project Manager")
    page.click("button:has-text('Simpan PM')")
    page.wait_for_timeout(800)
    unchecked = ".card:has(h2:has-text('Checklist handover')) input[type=checkbox]:not(:checked)"
    for i in range(8):
        n = page.locator(unchecked).count()
        if n == 0: break
        page.locator(unchecked).first.click()
        page.wait_for_function("([sel, n]) => document.querySelectorAll(sel).length < n", arg=[unchecked.replace(".card:has(h2:has-text('Checklist handover')) ", ""), n])
    page.click("button:has-text('Kickoff proyek')")
    page.wait_for_selector(".badge:has-text('KICKOFF')")
    shot(page, "p3-07-project-kickoff")

    # ── J. Wallet & kalkulator ──
    ui_login(page, "presales@defendit360.com")
    page.goto(f"{BASE}/flexguard/{wallet_id}")
    page.wait_for_selector("text=Ledger")
    shot(page, "p3-08-wallet")
    page.goto(f"{BASE}/flexguard")
    page.click("button:has-text('Kalkulator')")
    page.locator("input[type=number]").first.fill("120")
    page.click("button:has-text('Hitung')")
    page.wait_for_selector("[data-testid=calc-result]")
    check("kalkulator paket Business untuk 120 token", "Business" in page.locator("[data-testid=calc-result] h2").inner_text())
    shot(page, "p3-09-calculator")

    # ── K. Portal: service request ──
    ui_login(page, CUST)
    page.goto(f"{BASE}/portal/flexguard")
    page.wait_for_selector("text=Ajukan permintaan layanan")
    card = page.locator(".card:has(h2:has-text('Ajukan permintaan layanan'))")
    card.locator("select").nth(1).select_option("VAPT")
    card.locator("input").first.fill(f"VAPT Mobile Banking {stamp}")
    card.locator("textarea").fill("Pengujian aplikasi mobile banking Android & iOS")
    page.click("button:has-text('Kirim permintaan')")
    page.wait_for_selector("text=terkirim")
    s, srs = http("GET", "/api/v1/flexguard/requests", tok("presales@defendit360.com"))
    sr_id = next(x["id"] for x in srs["items"] if stamp in x["title"])

    # ── L. Presales estimasi via UI → Sales kirim (di bawah floor → approval) ──
    ui_login(page, "presales@defendit360.com")
    page.goto(f"{BASE}/flexguard/requests/{sr_id}")
    page.wait_for_selector("text=Estimasi MD")
    page.locator(".card:has(h2:has-text('Estimasi')) input[type=number]").first.fill("6")
    page.click("button:has-text('Simpan estimasi')")
    page.wait_for_selector("text=Estimasi 6 token")
    shot(page, "p3-10-sr-estimate")
    ui_login(page, "sales@defendit360.com")
    page.goto(f"{BASE}/flexguard/requests/{sr_id}")
    page.click("button:has-text('Kirim ke customer')")
    page.wait_for_timeout(800)
    s, srd = http("GET", f"/api/v1/flexguard/requests/{sr_id}", sales)
    if srd["request"].get("approvalRequestId"):
        for who in ["salesmanager", "vp", "direktur"]:
            http("POST", f"/api/v1/approvals/{srd['request']['approvalRequestId']}/decide", tok(f"{who}@defendit360.com"), {"decision": "APPROVE"})

    # ── M. Customer menyetujui estimasi → reserve ──
    ui_login(page, CUST)
    page.goto(f"{BASE}/portal/flexguard")
    page.click("button:has-text('Setujui estimasi')")
    page.wait_for_selector("text=token dicadangkan")
    shot(page, "p3-11-portal-flexguard")
    s, w = http("GET", f"/api/v1/flexguard/wallets/{wallet_id}", sales)
    check("reserve 6 token: available 156 / reserved 6", (float(w["wallet"]["availableTokens"]), float(w["wallet"]["reservedTokens"])) == (156, 6), w["wallet"])
    check("rekonsiliasi ledger OK", w["reconciliation"]["ok"])

    check("no JS page errors", not errors, errors[:3])
    b.close()

fails = [r for r in results if not r[1]]
for n, ok, info in results: print(("PASS " if ok else "FAIL ") + n + ("" if ok else f"  [{info}]"))
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
