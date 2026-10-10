# Phase 5 — Security Hardening & Production Release Gate (10 Oktober 2026)

## Yang diterapkan dalam paket source ini

1. Bootstrap **GitHub Actions CI**: typecheck/backend & frontend, regresi API+PostgreSQL 16, build, dan pemeriksaan dependensi risiko tinggi. Audit gagal = CI merah; ini berbeda dengan GitLab CI lama yang masih `allow_failure`.
2. **Fail closed** untuk rahasia awal: `JWT_SECRET` produksi minimum 32 karakter; konfigurasi DB produksi wajib berisi `DATABASE_URL` atau `DB_PASSWORD`; tidak ada password seed bawaan; `SEED_PASSWORD` produksi minimum 16 karakter dan kompleks. Akun yang sudah ada tidak diubah saat seed ulang.
3. **Trust proxy aman**: default `TRUST_PROXY=false` agar IP limit tidak dapat di-spoof dari header saat API terbuka; jika proxy tepercaya diperlukan, aktifkan eksplisit sambil memastikan API tidak terjangkau langsung.
4. **API Swagger UI** nonaktif saat `NODE_ENV=production` kecuali `API_DOCS_ENABLED=true`; OpenAPI dihasilkan lewat script khusus untuk engineering.
5. Docker Compose mem-publish port API hanya di `127.0.0.1:3001`; web tetap bisa meneruskan request antar container menggunakan `http://api:3001`.

## Release Gate — BELUM DINYATAKAN PASS

| Area | Bukti wajib | Status paket |
|---|---|---|
| CI | Workflow di GitHub menjalankan seluruh test + build pada branch main & PR | Workflow ditambahkan, **belum dijalankan di GitHub** |
| Security | Audit dependency 0 high/critical; SAST/DAST & pentest independen; secret scan | **Belum terverifikasi** |
| Identity | BFF dengan httpOnly Secure SameSite cookies (bukan bearer token di sessionStorage); MFA untuk privileged users; restore session, CSRF | **Belum selesai** |
| Data | Backup terjadwal, restore drill, per-tenant RBAC negatif, RPO/RTO disepakati | **Belum selesai** |
| Infrastruktur | TLS, gateway/reverse proxy, rate limiting trusted IP, vault/key rotation, log central | **Belum selesai** |
| Integrasi | VIDA sandbox asli, SMTP, S3/MinIO, feed tender dengan kredensial sah | **Belum diuji live** |
| Bisnis | Konfirmasi rate card, DoA, FlexGuard, Legal templates dan UAT sign-off | **Butuh validasi owner** |
| Deployment | Staging deployment, UI/mobile smoke, rollback test, monitoring/alert | **Belum terverifikasi** |

**Penting:** Laporan gate Phase 1–4 di `docs/14`–`docs/17` berasal dari paket sumber terlampir. Angka uji historis tidak otomatis membuktikan versi ini sudah lolos uji, terutama setelah hardening. Jalankan CI dan UAT baru sebelum mengubah gate produksi menjadi PASS.

## Konfigurasi production yang wajib

```env
NODE_ENV=production
JWT_SECRET=<nilai-acak-unik-minimal-32-karakter>
SECRETS_MASTER_KEY=<64-digit-hex>
DATABASE_URL=postgres://<user>:<password>@<private-db-host>:5432/<database>
SEED_PASSWORD=<hanya-ketika-provisioning-minimal-16-karakter-kompleks>
ALLOWED_ORIGINS=https://<domain-web>
TRUST_PROXY=false
API_DOCS_ENABLED=false
ESIGN_SANDBOX_ENABLED=false
```

Jangan masukkan konfigurasi dan password sungguhan ke repository. Pertahankan `.env` di server/secret manager, jauhkan database dan API dari internet publik, dan jalankan operasi seed hanya saat provisioning.
