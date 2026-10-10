# Phase 2b (lanjutan) + Phase 4 Gate Report — Pengesahan FlexGuard, Integrasi Admin, E-sign VIDA, Template Legal, Delivery, Billing, Helpdesk, Renewal

Tanggal uji: 2026-10-10 · Node 22, PostgreSQL 16, Next.js 14 production build, Chromium 390×844, server S3 nyata (moto), SMTP nyata (aiosmtpd), server VIDA tiruan sesuai dokumentasi resmi VSP OpenAPI.

## 1. Permintaan owner yang dieksekusi

| Permintaan | Implementasi |
|---|---|
| Tombol persetujuan FlexGuard untuk Direktur & Admin | Banner + tombol **Sahkan kebijakan FlexGuard** di halaman FlexGuard, hanya untuk `director` dan `company_admin` (`policy.activate`); catatan pengesahan wajib (≥10 karakter), maker-checker (pembuat kebijakan tidak boleh mengesahkan), tercatat di `source_note` + audit. Sales/Finance ditolak (403); pengesahan ulang ditolak (409) |
| Tanda tangan via kredensial Privy/VIDA by API | **VIDA: penuh** — adapter VSP OpenAPI sesuai docs.vida.id: token OAuth2 *client credentials* (cache sesuai masa berlaku), *Create Envelope* multipart (PDF final + `envelope_details`: penerima serial customer → penanda tangan DefendIT360, kotak tanda tangan di halaman terakhir), *Start Signature* (tautan tanda tangan per penerima), *Check Envelope Status* (polling tiap 15 menit + tombol **Cek status**; VSP OpenAPI tidak menyediakan webhook), *Download Signed Envelope* → PDF disimpan sebagai dokumen kontrak, tanda tangan **VERIFIED oleh PSrE**. **Privy: kredensial dapat diregistrasi**, pengiriman ditolak jujur (`501 ESIGN_ADAPTER_PENDING`) karena spesifikasi API Privy hanya tersedia lewat console.privy.id setelah kerja sama |
| Upload kontrak manual bertanda tangan | Tetap tersedia (internal & portal customer) → verifikasi Legal (maker-checker) |
| Menu khusus admin untuk API key / SMTP | **Pengaturan → Email (SMTP)** dan **Pengaturan → Integrasi** (Company Admin): SMTP, VIDA, Privy, object storage S3/MinIO, feed tender, API key layanan ingest SOC/VAPT, target SLA helpdesk. Semua rahasia dienkripsi AES-256-GCM (`SECRETS_MASTER_KEY`), tidak pernah dikembalikan (hanya petunjuk 4 karakter terakhir); URL wajib HTTPS (HTTP hanya localhost di luar production); setiap uji koneksi dicatat |
| Lanjutkan Phase 2b | SMTP + kirim surat penawaran via email; **MinIO/S3**: replikasi semua file (dokumen, tender, kontrak) dengan SSE, baca ulang dari bucket bila file lokal hilang, sinkronisasi file lama, profil `docker compose --profile minio`; **feed tender** JSON dari sumber sah (dedup + skor relevansi, terjadwal); template legal |
| Template sesuai best practice & perundang-undangan | 6 template: Surat Penawaran Harga, Surat Pernyataan Kesanggupan & Kebenaran Data, Pakta Integritas, Surat Kuasa Penandatanganan, Perjanjian Kerahasiaan (NDA), BAST Milestone. Acuan: UU 11/2008 jo. UU 1/2024 (ITE), UU 27/2022 (PDP), Perpres 16/2018 jo. Perpres 12/2021 (PBJ), UU 31/1999 jo. UU 20/2001 (Tipikor), KUHPerdata (Pasal 1338, 1792 dst.). Nilai di-escape; data kosong ditandai **[PERLU DILENGKAPI]** (tidak dikarang); watermark **DRAFT — BELUM DISAHKAN LEGAL** sampai Legal mengesahkan (catatan wajib); isi otomatis dari quotation; cetak/PDF |
| Lanjut Phase 4 | Lihat §2 |

## 2. Fitur Phase 4

| Modul | Yang berjalan |
|---|---|
| Delivery | WBS bertingkat (kode 1, 1.1, …; PIC, tanggal, MD rencana), progres & status (PIC hanya progres/status), progres tertimbang MD, varians jadwal, burn MD vs budget, task lewat tenggat; timesheet proyek (≤1,5 MD/orang/hari lintas task, unik per tanggal & task, tidak boleh masa depan, maker-checker); transisi status proyek (KICKOFF → IN_PROGRESS ↔ ON_HOLD → CLOSING → CLOSED; tunda wajib alasan; tutup wajib semua milestone BAST & timesheet diputuskan) |
| Change request | Nomor `CR-YYYY-NNNN`; CR tanpa dampak ditolak; approval DoA berdasarkan \|Δ nilai\| (`CONTRACT_VALUE`); disetujui → nilai & budget MD proyek, tanggal selesai, kewajiban pembayaran addendum + milestone tagihan baru |
| BAST & billing | BAST milestone (nomor unik) → invoice `NNN/DEIT-INV/<romawi>/<tahun>` ber-PPN sesuai kontrak (satu invoice aktif per milestone) → pembayaran append-only (tidak boleh melebihi sisa; PARTIAL/PAID) → batal hanya bila belum dibayar (dapat ditagih ulang) → status OVERDUE & aging (belum jatuh tempo, 1–30, 31–60, 61–90, >90 hari) → tagihan di portal customer |
| Dunning | Invoice jatuh tempo: L1 (≥1 hari), L2 (≥14), L3 (≥30, eskalasi Sales Manager & Direktur); email ke kontak finance/primary/procurement + PIC portal via SMTP tenant; sekali per level |
| Helpdesk & SLA | Tiket dari portal, internal, ingest SOC & VAPT; target SLA per prioritas (bawaan P1 15 mnt/4 jam, P2 1/8 jam, P3 4/24 jam, P4 8/72 jam; dapat diubah admin); balasan publik pertama = respons; catatan internal tidak terlihat customer & tidak dihitung respons; RESOLVED wajib ringkasan; customer konfirmasi/buka ulang; perubahan prioritas menghitung ulang target; pelanggaran SLA ditandai sekali & dieskalasi (P1 ke Direktur); komentar append-only |
| Ingest SOC/VAPT | `POST /api/v1/ingest/soc-alerts` dan `/vapt-findings` dengan `x-api-key` (hash SHA-256, scope, opsional terikat customer, dapat dicabut); severity → prioritas (critical P1 … low/info P4); idempoten per `externalId`; meta aset/CVSS/CVE |
| Renewal | Kontrak aktif H-180/90/60/30 (ambang terdekat, sekali per ambang) → notifikasi AM/Sales Manager + opportunity renewal otomatis (stage LEAD) |
| Scheduler | Satu runner (`scheduler.ts`): eskalasi approval, deadline tender, wallet, status e-sign VIDA, feed tender, SLA, renewal, dunning — tiap 15 menit atau manual |

## 3. Hasil pengujian

| Suite | Hasil |
|---|---|
| Typecheck API & web | PASS |
| Unit | 36/36 PASS |
| E2E Phase 1 / 2 / 3 (regresi) | 22/22 · 16/16 · 14/14 PASS |
| E2E Phase 2b-4: SMTP, template, billing, pengesahan FlexGuard | 17/17 PASS |
| E2E Integrasi: VIDA (server tiruan per spesifikasi), Privy, S3 (moto), feed tender, API key | 10/10 PASS |
| E2E Phase 4: delivery, CR, helpdesk, ingest, renewal, dunning | 13/13 PASS |
| **Total otomatis** | **128/128 PASS** |
| UI smoke Phase 1 / 2 / 3 (regresi, 390px) | 11/11 · 8/8 · 24/24 PASS |
| UI smoke Phase 2b + 4 (390px) | **30/30 PASS** — `infra/smoke/ui_smoke_phase4.py`, screenshot `docs/screenshots/phase4/` |
| Build frontend | PASS (41 route) · OpenAPI 179 path (v1.3.0-phase4) |

Alur UI yang diuji end-to-end: SMTP + email uji → Admin mengesahkan FlexGuard via tombol → Integrasi: VIDA (uji token), MinIO/S3 (uji + sinkronisasi), API key → Legal mengesahkan template → surat penawaran terkirim via email → kontrak: PDF final → e-sign VIDA (tautan tanda tangan) → *Cek status* → VERIFIED → aktif → WBS, timesheet disetujui, CR disetujui DoA → BAST → invoice → pembayaran sebagian → aging → tiket portal & tagihan portal → alert SOC masuk via API key → tiket P1 direspons & diselesaikan; tanpa error JS dan tanpa overflow horizontal.

Bug yang ditemukan lewat UI smoke dan diperbaiki: form SMTP tidak menyadari konfigurasi tersimpan (tombol uji nonaktif); tombol *Buat invoice* tidak tampil untuk Finance; milestone yang sudah ditagih kini menautkan invoice-nya.

## 4. Keterbatasan yang jujur

1. **Privy belum dapat mengirim dokumen** — spesifikasi API tidak publik (console.privy.id). Kredensial sudah bisa disimpan; adapter dibuat setelah dokumen API & akun sandbox Privy diterima.
2. **VIDA diuji dengan server tiruan** yang mengikuti dokumentasi resmi (endpoint, field, kode error). Wajib uji ulang dengan Environment URL & kredensial sandbox VIDA asli sebelum produksi; posisi kotak tanda tangan (x/y) perlu disesuaikan dengan template PKS final.
3. **Template legal** adalah draft standar praktik, bukan nasihat hukum — wajib direview & disahkan Legal ICOP (fitur pengesahan tersedia).
4. **SLA dihitung jam kalender** tanpa jeda saat menunggu customer dan tanpa kalender libur (Phase 5).
5. **Invoice belum terhubung e-Faktur/Coretax** dan belum ada nota kredit; pembatalan hanya untuk invoice yang belum dibayar.
6. Feed tender hanya dari endpoint JSON sumber sah (tanpa scraping portal pengadaan).
7. GitLab tetap tidak terjangkau dari lingkungan build — kirim via git bundle + `infra/push-to-gitlab.sh`.
