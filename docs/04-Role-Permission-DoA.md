# Role-Permission & Delegation of Authority Matrix

## 1. Role (20 role sesuai §S1)

`super_admin, company_admin, director, vp_head, sales_manager, account_manager, presales_engineer, solution_architect, pricing_finance, legal, tender_officer, procurement_officer, project_manager, delivery_engineer, soc_operations, product_manager, customer_support, auditor, partner_user, customer_user`

## 2. Permission (Phase 1)

| Permission | Role |
|---|---|
| `customer.read` | semua role internal |
| `customer.write` | super_admin, company_admin, sales_manager, account_manager, vp_head, director |
| `opportunity.read` / `.write` | sales_manager, account_manager, vp_head, director, presales_engineer (read), solution_architect (read) |
| `catalog.read` | semua internal · `catalog.write`: product_manager, company_admin, pricing_finance |
| `assessment.write` | presales_engineer, solution_architect, account_manager · `assessment.review`: presales_engineer, solution_architect |
| `pricing.calculate` | presales_engineer, solution_architect, pricing_finance, account_manager, sales_manager |
| `pricing.view_cost` (BoQ, floor, margin) | presales_engineer, solution_architect, pricing_finance, sales_manager, vp_head, director, auditor, company_admin |
| `pricing.policy.manage` | pricing_finance, company_admin (aktivasi butuh approval director — maker-checker) |
| `quotation.write` | account_manager, sales_manager, presales_engineer |
| `quotation.submit` | account_manager, sales_manager |
| `approval.decide` | sales_manager, vp_head, director (sesuai level DoA) |
| `ai.use` | semua internal · `ai.admin`: company_admin, super_admin |
| `audit.read` | auditor, company_admin, super_admin, director |
| `customer_portal.*` | customer_user — hanya data tenant + customer_id miliknya, **tanpa** field cost |

Semua dicek server-side (`requirePerm`) + filter `tenant_id`. UI hanya menyembunyikan tombol.

## 3. DoA — dua versi kebijakan

### `DOA-MP-2026.1` (master prompt; AKTIF default, status PENDING_OWNER_APPROVAL)

| Tipe | Manager | VP/Head | Direktur |
|---|---|---|---|
| QUOTATION_VALUE | ≤ Rp50 jt | >50 jt – ≤500 jt | >500 jt |
| DISCOUNT | ≤ 5% | >5% – ≤15% | >15% |
| CONTRACT_VALUE | ≤ Rp50 jt | >50 – ≤250 jt | >250 jt |
| TENDER | registrasi/pengajuan | Go/No-Go | final > Rp1 M |
| MARGIN_EXCEPTION | — | — | selalu Direktur |

### `DOA-BRD-2.0` (alternatif)

| Tipe | Head Sales (L2) | Direktur (L3) |
|---|---|---|
| QUOTATION_VALUE | ≤ Rp250 jt | > 250 jt |
| DISCOUNT | ≤ 15% | > 15% |

## 4. Aturan engine

1. Semua aturan yang match dievaluasi; level tertinggi menang (**most stringent**), level di bawahnya ikut sebagai approval berurutan jika `sequential=true`.
2. **SoD / maker-checker**: pembuat request tidak boleh menyetujui request sendiri, walau punya role cukup.
3. Approver level X boleh memutus step level ≤ X (Direktur boleh mengambil step VP).
4. Keputusan tersimpan di `approval_decisions` — append-only (trigger DB menolak UPDATE/DELETE).
5. Perubahan quotation setelah approved (harga, diskon, lines) → status kembali `DRAFT`, approval lama `SUPERSEDED`.
6. Quotation hanya bisa `ISSUED` bila approval request terkait `APPROVED` — dicek di server dan di constraint transaksi.
