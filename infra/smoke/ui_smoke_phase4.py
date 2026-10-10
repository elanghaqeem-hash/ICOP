"""
UI smoke Phase 2b + 4 (mobile 390x844), lanjutan dari DB ui_smoke_phase3:
SMTP → pengesahan FlexGuard (Admin) → Integrasi (VIDA, S3/MinIO, API key) → Legal sahkan template → kirim penawaran via email →
kontrak: PDF final → e-sign VIDA → cek status → VERIFIED → aktif → delivery (WBS, timesheet, CR) → BAST → invoice → pembayaran → aging →
portal: tiket & tagihan → ingest alert SOC → Helpdesk menyelesaikan tiket.

Pakai: python3 ui_smoke_phase4.py <base_url> <seed_password> <out_dir> <smtp_host> <smtp_port> <vida_url> <s3_url> <final_pdf>
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE, SEED_PW, OUT, SMTP_HOST, SMTP_PORT, VIDA_URL, S3_URL, FINAL_PDF = sys.argv[1:9]
NEW_PW = "Ui!Smoke-Passw0rd"
CUST = "pic@walletui.co.id"
OUT = Path(OUT); OUT.mkdir(parents=True, exist_ok=True)
results, tokens = [], {}
stamp = time.strftime("%H%M%S")


def check(name, ok, info=""):
    results.append((name, bool(ok), info))


def http(method, path, token=None, body=None, idem=None, base=None, headers=None):
    h = {"content-type": "application/json", **(headers or {})}
    if token: h["authorization"] = f"Bearer {token}"
    if idem: h["idempotency-key"] = idem
    data = json.dumps(body or {}).encode() if method != "GET" else None
    req = urllib.request.Request((base or BASE) + path, method=method, headers=h, data=data)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def tok(email):
    if email in tokens: return tokens[email]
    s, b = http("POST", "/api/v1/auth/login", body={"email": email, "password": NEW_PW})
    if s != 200:
        s, b = http("POST", "/api/v1/auth/login", body={"email": email, "password": SEED_PW})
        if b["user"].get("forcePasswordChange"):
            s, b = http("POST", "/api/v1/auth/change-password", b["token"], {"currentPassword": SEED_PW, "newPassword": NEW_PW})
    tokens[email] = b["token"]
    return b["token"]


def approve(ar_id, steps):
    for st in steps:
        who = {1: "salesmanager", 2: "vp", 3: "direktur"}[st["level"]]
        http("POST", f"/api/v1/approvals/{ar_id}/decide", tok(f"{who}@defendit360.com"), {"decision": "APPROVE"})


def shot(page, name):
    page.wait_for_timeout(500)
    w = page.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
    check(f"no horizontal overflow: {name}", w[0] <= w[1] + 1, f"{w[0]} vs {w[1]}")
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)


def ui_login(page, email):
    tok(email)
    if page.url.startswith(BASE): page.evaluate("() => sessionStorage.clear()")
    page.goto(f"{BASE}/login")
    page.fill("input[type=email]", email)
    page.fill("input[type=password]", NEW_PW if email != CUST else SEED_PW)
    page.click("button:has-text('Masuk')")
    page.wait_for_url(re.compile(r"/(portal)?$"))


def field(scope, label):
    return scope.locator(f".field:has(label:has-text('{label}')) input").first


def accepted_quotation(title, price):
    sales = tok("sales@defendit360.com")
    s, cust = http("GET", "/api/v1/customers?q=Wallet%20UI", sales)
    cid = cust["items"][0]["id"]
    s, o = http("POST", "/api/v1/opportunities", sales, {"customerId": cid, "name": title, "serviceCategory": "VAPT", "amountEstimate": price})
    s, q = http("POST", "/api/v1/quotations", sales, {"opportunityId": o["id"], "title": title, "lines": [{"description": "Uji penetrasi aplikasi", "qty": 1, "unit": "paket", "unitPrice": price}]})
    s, sub = http("POST", f"/api/v1/quotations/{q['id']}/submit", sales, idem=f"s{title}")
    approve(sub["approvalRequestId"], sub["steps"])
    http("POST", f"/api/v1/quotations/{q['id']}/issue", sales, idem=f"i{title}")
    return q["id"], cid


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())

    # A. Admin: SMTP
    ui_login(page, "companyadmin@defendit360.com")
    page.goto(f"{BASE}/settings")
    page.click("button:has-text('Email (SMTP)')")
    page.wait_for_selector("h2:has-text('Email (SMTP)')")
    page.locator("label.check:has-text('Aktifkan pengiriman email') input").check()
    page.fill("input[placeholder='smtp.office365.com']", SMTP_HOST)
    page.locator(".card:has(h2:has-text('Email (SMTP)')) input[type=number]").fill(SMTP_PORT)
    field(page, "Nama pengirim").fill("DefendIT360 ICOP")
    field(page, "Email pengirim").fill("noreply@defendit360.com")
    page.get_by_role("button", name="Simpan", exact=True).click()
    page.wait_for_selector("text=Konfigurasi SMTP tersimpan")
    field(page, "Uji koneksi").fill("admin@defendit360.com")
    page.click("button:has-text('Kirim email uji')")
    page.wait_for_selector("text=Email uji terkirim")
    check("SMTP tersimpan & email uji diterima server SMTP", True)
    shot(page, "p4-01-smtp-settings")

    # B. Admin: pengesahan FlexGuard lewat tombol persetujuan
    page.goto(f"{BASE}/flexguard")
    card = page.locator("[data-testid=flexguard-approval]")
    card.wait_for()
    card.locator("input").fill("Parameter ditinjau Finance & disetujui untuk produksi")
    card.locator("button:has-text('Sahkan kebijakan FlexGuard')").click()
    page.wait_for_selector("text=disahkan dan berlaku")
    s, pol = http("GET", "/api/v1/flexguard/policy", tok("companyadmin@defendit360.com"))
    check("Admin mengesahkan FLEXGUARD-PD1 lewat tombol persetujuan", pol["status"] == "ACTIVE", pol["status"])
    shot(page, "p4-02-flexguard-approved")

    # C. Admin: Integrasi — VIDA, S3/MinIO, API key layanan
    import boto3
    try:
        boto3.client("s3", endpoint_url=S3_URL, region_name="us-east-1", aws_access_key_id="minio", aws_secret_access_key="minio-secret").create_bucket(Bucket="icop-docs")
    except Exception as e:  # bucket sudah ada dari putaran sebelumnya
        if "BucketAlready" not in str(e): raise
    page.goto(f"{BASE}/settings")
    page.click("button:has-text('Integrasi')")
    vida = page.locator("[data-integration=ESIGN_VIDA]")
    vida.wait_for()
    vida.locator("label.check:has-text('Aktifkan') input").check()
    field(vida, "Environment URL").fill(VIDA_URL)
    field(vida, "Email pembuat envelope").fill("legal@defendit360.com")
    vida.locator("input[aria-label='Client ID']").fill("vida-client")
    vida.locator("input[aria-label='Client Secret']").fill("vida-secret-123")
    vida.get_by_role("button", name="Simpan", exact=True).click()
    vida.locator(".alert.info:has-text('Tersimpan')").wait_for()
    vida.get_by_role("button", name="Uji koneksi").click()
    vida.locator("text=Berhasil: Token VIDA diterima").wait_for()
    check("kredensial VIDA tersimpan & uji token OAuth2 berhasil", True)
    s3 = page.locator("[data-integration=STORAGE_S3]")
    s3.locator("label.check:has-text('Aktifkan') input").first.check()
    field(s3, "Endpoint").fill(S3_URL)
    field(s3, "Region").fill("us-east-1")
    field(s3, "Bucket").fill("icop-docs")
    field(s3, "Prefix").fill("icop/")
    s3.locator(".field:has(label:has-text('Path-style')) input[type=checkbox]").check()
    s3.locator("input[aria-label='Access key ID']").fill("minio")
    s3.locator("input[aria-label='Secret access key']").fill("minio-secret")
    s3.get_by_role("button", name="Simpan", exact=True).click()
    s3.locator(".alert.info:has-text('Tersimpan')").wait_for()
    s3.get_by_role("button", name="Uji koneksi").click()
    s3.locator("text=Berhasil: Bucket icop-docs").wait_for()
    s3.get_by_role("button", name="Sinkronkan file lama").click()
    s3.locator("text=Sinkronisasi:").wait_for()
    check("object storage S3/MinIO: uji & sinkronisasi file lama", True)
    keys = page.locator(".card:has(h2:has-text('API key layanan'))")
    keys.locator("input[placeholder='Rapid7 InsightIDR']").fill("Rapid7 InsightIDR")
    keys.locator("select").nth(1).select_option(label="PT Bank Wallet UI")
    keys.locator("button:has-text('Buat API key')").click()
    api_key = keys.locator(".alert.warn .mono").inner_text()
    check("API key layanan dibuat & ditampilkan sekali", api_key.startswith("icop_"), api_key[:12])
    shot(page, "p4-03-integrations")

    # D. Legal: sahkan template surat penawaran
    ui_login(page, "legal@defendit360.com")
    page.goto(f"{BASE}/templates")
    page.click("button.list-item:has-text('Surat Penawaran Harga')")
    field(page, "Catatan pengesahan Legal").fill("Ditinjau Legal sesuai Perpres 16/2018 jo. 12/2021")
    page.click("button:has-text('Sahkan template')")
    page.wait_for_selector("button.list-item:has-text('Surat Penawaran Harga') >> text=DISAHKAN")
    check("Legal mengesahkan template", True)
    shot(page, "p4-04-template-approved")

    # E. Sales: kirim surat penawaran via email
    qid, cid = accepted_quotation(f"Penawaran email {stamp}", 50000000)
    ui_login(page, "sales@defendit360.com")
    page.goto(f"{BASE}/quotations/{qid}")
    page.locator(".card:has(h2:has-text('Kirim surat penawaran via email')) input").fill("pic@walletui.co.id")
    page.click("button:has-text('Kirim email')")
    page.wait_for_selector("text=Surat terkirim ke 1 alamat")
    check("surat penawaran terkirim via SMTP tenant", True)

    # F. Kontrak: PDF final → e-sign VIDA → status → VERIFIED → aktif
    q2, _ = accepted_quotation(f"VAPT Core Banking {stamp}", 120000000)
    http("POST", f"/api/v1/quotations/{q2}/mark-sent", tok("sales@defendit360.com"), {"channel": "portal"}, idem=f"m{stamp}")
    s, r = http("POST", f"/api/v1/portal/quotations/{q2}/respond", tok(CUST), {"response": "ACCEPT", "acknowledgement": True})
    s, con = http("POST", f"/api/v1/contracts/from-quotation/{q2}", tok("sales@defendit360.com"), {"contractType": "PROJECT", "startDate": "2026-11-01", "endDate": "2027-04-30"}, idem=f"c{stamp}")
    check("kontrak dibuat dari quotation ACCEPTED", s == 201, con)
    page.goto(f"{BASE}/contracts/{con['id']}")
    page.set_input_files("input[aria-label='PDF kontrak final']", FINAL_PDF)
    page.click("button:has-text('Unggah PDF final')")
    page.wait_for_selector("text=PDF final tersimpan")
    sales = tok("sales@defendit360.com")
    http("POST", f"/api/v1/contracts/{con['id']}/submit-legal", sales)
    s, det = http("GET", f"/api/v1/contracts/{con['id']}", sales)
    s, lr = http("POST", f"/api/v1/contracts/{con['id']}/legal-review", tok("legal@defendit360.com"), {"checklist": {k: True for k in det["legalChecklistKeys"]}, "decision": "APPROVE"})
    approve(lr["approvalRequestId"], lr["steps"])
    page.goto(f"{BASE}/contracts/{con['id']}")
    page.locator("select:has(option[value='vida'])").select_option("vida")
    field(page, "Nama penanda tangan customer").fill("Bpk. Direktur Bank")
    field(page, "Email penanda tangan customer").fill("direktur@walletui.co.id")
    field(page, "Penanda tangan DefendIT360").fill("Direktur Utama DEIT")
    field(page, "Email penanda tangan DefendIT360").fill("direktur@defendit360.com")
    page.click("button:has-text('Kirim permintaan tanda tangan')")
    page.wait_for_selector("text=Permintaan tanda tangan dikirim")
    check("envelope VIDA dibuat dengan tautan tanda tangan", page.locator("text=sign.vida.id").count() >= 1)
    shot(page, "p4-05-contract-vida-pending")
    urllib.request.urlopen(urllib.request.Request(VIDA_URL + "/_complete", method="POST", data=b""))
    page.click("button:has-text('Cek status')")
    page.wait_for_selector("text=Status diperbarui: VERIFIED")
    http("POST", f"/api/v1/contracts/{con['id']}/signatures/internal", tok("direktur@defendit360.com"), {"signerTitle": "Direktur Utama", "confirm": True})
    s, act = http("POST", f"/api/v1/contracts/{con['id']}/activate", sales, idem=f"a{stamp}")
    check("kontrak aktif setelah tanda tangan VIDA terverifikasi", s == 200 and act.get("status") == "ACTIVE", act)
    page.goto(f"{BASE}/contracts/{con['id']}")
    page.wait_for_selector(".badge:has-text('ACTIVE')")
    shot(page, "p4-06-contract-vida-verified")

    # G. Delivery pada proyek dari smoke Phase 3: WBS, timesheet, CR
    s, pr = http("GET", "/api/v1/projects", tok("pm@defendit360.com"))
    proj = next(x for x in pr["items"] if x["customerName"] == "PT Bank Wallet UI" and x["status"] in ("KICKOFF", "IN_PROGRESS"))
    ui_login(page, "pm@defendit360.com")
    page.goto(f"{BASE}/projects/{proj['id']}")
    page.wait_for_selector("h2:has-text('WBS')")
    field(page, "Nama task").fill("Pengujian aplikasi mobile")
    page.locator(".field:has(label:text-is('PIC')) select").select_option(label="Pre-Sales Engineer")
    field(page, "MD rencana").fill("4")
    page.click("button:has-text('Tambah task')")
    page.wait_for_selector("td:has-text('Pengujian aplikasi mobile')")
    ui_login(page, "presales@defendit360.com")
    page.goto(f"{BASE}/projects/{proj['id']}")
    page.wait_for_selector("h2:has-text('Timesheet proyek')")
    page.locator(".field:has(label:text-is('Task')) select").select_option(index=1)
    page.click("button:has-text('Catat timesheet')")
    page.wait_for_selector("text=Timesheet tercatat")
    ui_login(page, "pm@defendit360.com")
    page.goto(f"{BASE}/projects/{proj['id']}")
    page.locator(".card:has(h2:has-text('Timesheet proyek')) button:has-text('Setujui')").first.click()
    page.wait_for_selector(".card:has(h2:has-text('Timesheet proyek')) .badge:has-text('APPROVED')")
    field(page, "Judul").fill("Tambah pengujian API publik")
    page.locator(".field:has(label:text-is('Deskripsi perubahan')) textarea").fill("Penambahan 12 endpoint API publik ke ruang lingkup VAPT")
    field(page, "Alasan").fill("Permintaan customer setelah kickoff")
    field(page, "Δ nilai").fill("30000000")
    field(page, "Δ jadwal").fill("7")
    page.click("button:has-text('Simpan CR')")
    page.wait_for_selector("text=Change request dibuat")
    page.click("button:has-text('Ajukan approval')")
    page.wait_for_selector("text=diajukan ke approval DoA")
    s, dl = http("GET", f"/api/v1/projects/{proj['id']}/delivery", tok("pm@defendit360.com"))
    crr = dl["changeRequests"][0]
    s, ar = http("GET", f"/api/v1/approvals/{crr['approvalRequestId']}", tok("salesmanager@defendit360.com"))
    approve(crr["approvalRequestId"], ar["steps"])
    page.reload()
    page.wait_for_selector(".card:has(h2:has-text('Change request')) .badge:has-text('APPROVED')")
    check("delivery: WBS, timesheet disetujui, CR disetujui DoA", True)
    shot(page, "p4-07-project-delivery")

    # H. BAST → invoice → pembayaran → aging
    s, det = http("GET", f"/api/v1/projects/{proj['id']}", tok("pm@defendit360.com"))
    m = next(x for x in det["milestones"] if x["status"] == "PLANNED" and not x["name"].startswith("Addendum"))
    mrow = page.locator(f"tr:has-text('{m['name']}')").first
    mrow.locator("input[aria-label='Nomor BAST']").fill(f"BAST-UI-{stamp}/DEIT/X/2026")
    mrow.locator("button:has-text('Terima BAST')").click()
    page.wait_for_selector(f"text=BAST-UI-{stamp}")
    ui_login(page, "finance@defendit360.com")
    page.goto(f"{BASE}/projects/{proj['id']}")
    page.locator("tr:has-text('BAST-UI-') button:has-text('Buat invoice')").first.click()
    page.wait_for_url(re.compile("/billing/"))
    page.wait_for_selector("text=Catat pembayaran")
    s, invs = http("GET", "/api/v1/invoices?status=ISSUED", tok("finance@defendit360.com"))
    inv = next(x for x in invs["items"] if x["projectCode"] == proj["code"])
    check("invoice ber-PPN dengan nomor skema DEIT-INV", "/DEIT-INV/" in inv["number"], inv["number"])
    page.locator(".card:has(h2:has-text('Catat pembayaran')) input[type=number]").fill(str(round(float(inv["total"]) / 2, 2)))
    field(page, "Referensi").fill(f"TRF-UI-{stamp}")
    page.click("button:has-text('Simpan pembayaran')")
    page.wait_for_selector("text=Status: PARTIAL")
    shot(page, "p4-08-invoice-partial")
    page.goto(f"{BASE}/billing")
    page.wait_for_selector("text=Total piutang")
    shot(page, "p4-09-billing-aging")

    # I. Ingest alert SOC (API key) → tiket P1
    s, ing = http("POST", "/api/v1/ingest/soc-alerts", body={"externalId": f"R7-{stamp}", "severity": "critical", "title": "Lateral movement via PsExec",
        "description": "InsightIDR: eksekusi PsExec dari FIN-PC-07 ke DC01", "asset": "FIN-PC-07"}, headers={"x-api-key": api_key})
    check("alert SOC critical masuk sebagai tiket P1", s == 201 and ing.get("priority") == "P1", ing)

    # J. Customer: tiket portal & tagihan
    ui_login(page, CUST)
    page.goto(f"{BASE}/portal/tickets")
    field(page, "Judul").fill("Email phishing ke direksi")
    page.locator(".field:has(label:has-text('Uraian')) textarea").fill("Tiga direksi menerima email berisi tautan login palsu pagi ini")
    page.locator(".field:has(label:text-is('Urgensi')) select").select_option("P2")
    page.click("button:has-text('Kirim laporan')")
    page.wait_for_selector("text=Target respons")
    check("customer membuat tiket di portal", True)
    shot(page, "p4-10-portal-tickets")
    page.goto(f"{BASE}/portal/invoices")
    page.wait_for_selector(f"text={inv['number']}")
    check("customer melihat invoice di portal", True)
    shot(page, "p4-11-portal-invoices")

    # K. Helpdesk: tangani tiket P1 hasil ingest
    ui_login(page, "pm@defendit360.com")
    page.goto(f"{BASE}/helpdesk")
    page.wait_for_selector("text=Lateral movement via PsExec")
    shot(page, "p4-12-helpdesk-list")
    page.click("text=Lateral movement via PsExec")
    page.wait_for_url(re.compile("/helpdesk/"))
    page.locator(".field:has(label:text-is('Balas')) textarea").fill("Host FIN-PC-07 diisolasi via EDR; investigasi berjalan.")
    page.click("button:has-text('Kirim')")
    page.wait_for_selector("text=Host FIN-PC-07 diisolasi")
    page.locator(".field:has(label:has-text('Ringkasan penyelesaian')) textarea").fill("Akun yang disalahgunakan dinonaktifkan, kredensial direset, IOC diblokir di firewall.")
    page.locator("button.btn.ok:has-text('RESOLVED')").click()
    page.wait_for_selector(".badge:has-text('RESOLVED')")
    check("tiket P1 direspons & diselesaikan di Helpdesk", True)
    shot(page, "p4-13-helpdesk-resolved")

    check("no JS page errors", not errors, errors[:3])
    b.close()

fails = [r for r in results if not r[1]]
for n, ok, info in results: print(("PASS " if ok else "FAIL ") + n + ("" if ok else f"  [{info}]"))
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
