/**
 * Katalog template surat & dokumen legal (Bahasa Indonesia).
 * Dasar: UU 11/2008 jo. UU 1/2024 (ITE), UU 27/2022 (PDP), Perpres 16/2018 jo. Perpres 12/2021 (PBJ Pemerintah),
 * UU 31/1999 jo. UU 20/2001 (Tipikor), KUHPerdata (Buku III). Template ini disusun sebagai standar praktik profesional;
 * wajib direview Legal ICOP sebelum disahkan dan dipakai (status PENDING_LEGAL → APPROVED).
 */
export interface TemplateField { key: string; label: string; required: boolean; multiline?: boolean }
export interface TemplateDef {
  code: string; title: string; category: 'PENAWARAN' | 'PERNYATAAN' | 'KONTRAK' | 'SERAH_TERIMA';
  legalBasis: string; fields: TemplateField[]; body: string; // paragraf dipisah baris kosong; {{key}} = placeholder
}

const F = (key: string, label: string, required = true, multiline = false): TemplateField => ({ key, label, required, multiline });
const COMMON_SIGN = [F('namaPenandatangan', 'Nama penandatangan'), F('jabatanPenandatangan', 'Jabatan penandatangan'), F('kotaTanggal', 'Kota & tanggal')];

export const TEMPLATES: TemplateDef[] = [
  {
    code: 'SURAT_PENAWARAN', title: 'Surat Penawaran Harga', category: 'PENAWARAN',
    legalBasis: 'Perpres 16/2018 jo. Perpres 12/2021 (dokumen penawaran); KUHPerdata Buku III (penawaran & penerimaan).',
    fields: [F('nomorSurat', 'Nomor surat'), F('namaPenerima', 'Nama penerima (jabatan & instansi)'), F('perihal', 'Perihal'), F('namaProyek', 'Nama pekerjaan / proyek'),
      F('nilaiPenawaran', 'Nilai penawaran (terbilang & angka, sebelum PPN)'), F('ppn', 'Keterangan PPN'), F('jangkaWaktu', 'Jangka waktu pelaksanaan'), F('masaBerlaku', 'Masa berlaku penawaran (hari)'),
      F('termin', 'Termin pembayaran', true, true), ...COMMON_SIGN],
    body: `Kepada Yth.
{{namaPenerima}}

Perihal: {{perihal}}

Dengan hormat,

Bersama surat ini, PT Data Enkripsi Informasi Teknologi (DefendIT360) menyampaikan penawaran harga untuk pekerjaan {{namaProyek}}, sebagaimana tertuang dalam dokumen penawaran terlampir.

Nilai penawaran kami sebesar {{nilaiPenawaran}}. {{ppn}}

Jangka waktu pelaksanaan: {{jangkaWaktu}}. Pembayaran dilakukan dengan termin sebagai berikut:
{{termin}}

Penawaran ini berlaku {{masaBerlaku}} hari kalender sejak tanggal surat ini. Penawaran tidak mengikat sebelum diterbitkan perjanjian/kontrak yang ditandatangani kedua belah pihak.

Demikian surat penawaran ini kami sampaikan. Atas perhatian dan kesempatan yang diberikan, kami ucapkan terima kasih.

Hormat kami,
PT Data Enkripsi Informasi Teknologi

{{namaPenandatangan}}
{{jabatanPenandatangan}}
{{kotaTanggal}}`,
  },
  {
    code: 'PERNYATAAN_KESANGGUPAN', title: 'Surat Pernyataan Kesanggupan & Kebenaran Data', category: 'PERNYATAAN',
    legalBasis: 'Perpres 16/2018 jo. Perpres 12/2021 (surat pernyataan dalam dokumen penawaran); UU 1/2024 (ITE) untuk tanda tangan elektronik; UU 27/2022 (PDP).',
    fields: [F('namaPerusahaan', 'Nama perusahaan'), F('alamatPerusahaan', 'Alamat perusahaan', true, true), F('namaProyek', 'Nama pekerjaan / tender'), F('nomorTender', 'Nomor tender / RFQ'), ...COMMON_SIGN],
    body: `Yang bertanda tangan di bawah ini {{namaPenandatangan}}, {{jabatanPenandatangan}} dari {{namaPerusahaan}}, beralamat di {{alamatPerusahaan}}, dengan ini menyatakan dengan sebenarnya bahwa:

1. Kami sanggup dan bersedia melaksanakan pekerjaan {{namaProyek}} ({{nomorTender}}) sesuai dengan spesifikasi, ruang lingkup, dan ketentuan dalam dokumen pemilihan.
2. Kami tidak sedang dinyatakan pailit, tidak sedang dalam pengawasan pengadilan, dan tidak sedang dalam proses likuidasi.
3. Kami tidak masuk dalam daftar hitam (blacklist) dan tidak sedang dikenakan sanksi oleh instansi pemerintah maupun swasta.
4. Kami tidak memiliki hubungan kepentingan yang dapat memengaruhi objektivitas proses pemilihan.
5. Seluruh data, dokumen, dan informasi yang kami sampaikan adalah benar dan dapat dipertanggungjawabkan. Apabila di kemudian hari ditemukan pernyataan tidak benar, kami bersedia menerima sanksi sesuai ketentuan yang berlaku, termasuk pembatalan penetapan pemenang.

Pernyataan ini kami buat dengan sesungguhnya dan dapat dipergunakan sebagaimana mestinya.

{{kotaTanggal}}
{{jabatanPenandatangan}}
{{namaPerusahaan}}

{{namaPenandatangan}}`,
  },
  {
    code: 'PAKTA_INTEGRITAS', title: 'Pakta Integritas', category: 'PERNYATAAN',
    legalBasis: 'Perpres 16/2018 jo. Perpres 12/2021 (pakta integritas wajib dalam pengadaan); UU 31/1999 jo. UU 20/2001 (Tipikor).',
    fields: [F('namaPerusahaan', 'Nama perusahaan'), F('namaProyek', 'Nama pekerjaan / tender'), F('nomorTender', 'Nomor tender / RFQ'), ...COMMON_SIGN],
    body: `Dalam rangka {{namaProyek}} ({{nomorTender}}), kami yang bertanda tangan di bawah ini, {{namaPenandatangan}} selaku {{jabatanPenandatangan}} dari {{namaPerusahaan}}, menyatakan bahwa kami:

1. Tidak akan melakukan praktik korupsi, kolusi, dan nepotisme (KKN), suap, gratifikasi, maupun pemberian imbalan dalam bentuk apa pun kepada pejabat atau pihak mana pun untuk memengaruhi proses pemilihan, penetapan, atau pelaksanaan pekerjaan.
2. Tidak akan mengajukan dokumen, data, atau keterangan palsu, serta tidak akan menyembunyikan informasi material yang relevan.
3. Akan melaksanakan pekerjaan secara profesional, jujur, dan bertanggung jawab sesuai kontrak.
4. Bersedia mematuhi seluruh ketentuan kerahasiaan dan perlindungan data pribadi sesuai peraturan perundang-undangan yang berlaku.
5. Apabila melanggar pakta integritas ini, kami bersedia dikenakan sanksi administratif, pemutusan kontrak, pencantuman dalam daftar hitam, serta proses hukum sesuai peraturan perundang-undangan.

{{kotaTanggal}}
{{namaPerusahaan}}

{{namaPenandatangan}}
{{jabatanPenandatangan}}`,
  },
  {
    code: 'SURAT_KUASA', title: 'Surat Kuasa Penandatanganan', category: 'PERNYATAAN',
    legalBasis: 'KUHPerdata Pasal 1792 dst. (pemberian kuasa); Perpres 16/2018 jo. Perpres 12/2021 (kewenangan penandatanganan dokumen penawaran).',
    fields: [F('namaPemberi', 'Nama pemberi kuasa (direktur/pejabat berwenang)'), F('jabatanPemberi', 'Jabatan pemberi kuasa'), F('namaPerusahaan', 'Nama perusahaan'), F('alamatPerusahaan', 'Alamat perusahaan', true, true),
      F('namaPenerima', 'Nama penerima kuasa'), F('jabatanPenerima', 'Jabatan penerima kuasa'), F('nikPenerima', 'NIK penerima kuasa'), F('ruangLingkup', 'Ruang lingkup kuasa', true, true), F('masaBerlaku', 'Masa berlaku kuasa'), F('kotaTanggal', 'Kota & tanggal')],
    body: `Yang bertanda tangan di bawah ini {{namaPemberi}}, {{jabatanPemberi}} dari {{namaPerusahaan}}, beralamat di {{alamatPerusahaan}}, dengan ini memberikan kuasa kepada:

Nama: {{namaPenerima}}
Jabatan: {{jabatanPenerima}}
NIK: {{nikPenerima}}

untuk bertindak atas nama dan mewakili kami dalam hal berikut:
{{ruangLingkup}}

Kuasa ini berlaku {{masaBerlaku}} dan dapat ditarik kembali sewaktu-waktu dengan pemberitahuan tertulis.

{{kotaTanggal}}
Pemberi Kuasa,
{{namaPemberi}}
{{jabatanPemberi}}

Penerima Kuasa,
{{namaPenerima}}`,
  },
  {
    code: 'PERJANJIAN_KERAHASIAAN', title: 'Perjanjian Kerahasiaan (NDA)', category: 'KONTRAK',
    legalBasis: 'KUHPerdata Pasal 1338 (kebebasan berkontrak & kekuatan mengikat); UU 27/2022 (PDP) untuk data pribadi; UU 1/2024 (ITE).',
    fields: [F('pihakPertama', 'Pihak pertama (nama, jabatan, alamat)', true, true), F('pihakKedua', 'Pihak kedua (nama, jabatan, alamat)', true, true), F('tujuan', 'Tujuan informasi rahasia', true, true),
      F('jangkaWaktu', 'Jangka waktu kerahasiaan (tahun)'), F('yurisdiksi', 'Domisili hukum / pengadilan'), ...COMMON_SIGN],
    body: `Perjanjian Kerahasiaan ini dibuat pada {{kotaTanggal}} antara:

Pihak Pertama: {{pihakPertama}}
Pihak Kedua: {{pihakKedua}}

Tujuan: {{tujuan}}

Para pihak sepakat:
1. Informasi Rahasia adalah setiap informasi teknis, bisnis, keamanan siber, arsitektur sistem, kredensial, data pelanggan, dan data pribadi yang diungkapkan para pihak dalam rangka tujuan di atas, baik tertulis, lisan, maupun elektronik.
2. Pihak penerima wajib menjaga kerahasiaan Informasi Rahasia, tidak mengungkapkannya kepada pihak ketiga tanpa persetujuan tertulis, dan hanya menggunakannya untuk tujuan.
3. Untuk data pribadi, pihak penerima wajib memproses sesuai UU 27/2022 tentang Pelindungan Data Pribadi, termasuk pembatasan tujuan, keamanan, dan pemberitahuan insiden dalam waktu yang wajar.
4. Kewajiban kerahasiaan berlaku {{jangkaWaktu}} tahun sejak perjanjian ini ditandatangani, atau selama informasi tersebut masih bersifat rahasia menurut hukum.
5. Pengecualian: informasi yang sudah menjadi milik umum tanpa kesalahan penerima, atau wajib diungkapkan berdasarkan perintah peraturan perundang-undangan/pengadilan.
6. Sengketa diselesaikan secara musyawarah; apabila tidak tercapai, para pihak sepakat memilih {{yurisdiksi}}.

Perjanjian ini dibuat dalam rangkap dua dan ditandatangani secara sah oleh para pihak.

Pihak Pertama,                    Pihak Kedua,
{{namaPenandatangan}}             (nama & tanda tangan)
{{jabatanPenandatangan}}`,
  },
  {
    code: 'BAST_MILESTONE', title: 'Berita Acara Serah Terima (BAST) Milestone', category: 'SERAH_TERIMA',
    legalBasis: 'Klausul serah terima dalam kontrak yang berlaku; KUHPerdata Pasal 1338; UU 1/2024 (ITE) untuk BAST elektronik.',
    fields: [F('nomorBast', 'Nomor BAST'), F('namaProyek', 'Nama proyek'), F('nomorKontrak', 'Nomor kontrak'), F('namaMilestone', 'Nama milestone / deliverable', true, true),
      F('nilaiTermin', 'Nilai termin (terbilang & angka)'), F('ringkasanHasil', 'Ringkasan hasil pekerjaan & bukti (laporan, referensi dokumen)', true, true),
      F('pihakPertama', 'Pihak pertama (penyedia) — nama & jabatan'), F('pihakKedua', 'Pihak kedua (pengguna/customer) — nama & jabatan'), F('kotaTanggal', 'Kota & tanggal')],
    body: `Pada hari ini {{kotaTanggal}}, kami yang bertanda tangan di bawah ini:

1. {{pihakPertama}}, selanjutnya disebut Pihak Pertama (Penyedia).
2. {{pihakKedua}}, selanjutnya disebut Pihak Kedua (Pengguna).

Dengan ini menyatakan bahwa Pihak Pertama telah menyerahkan dan Pihak Kedua telah menerima hasil pekerjaan sebagai berikut:

Proyek: {{namaProyek}}
Nomor kontrak: {{nomorKontrak}}
Milestone / deliverable: {{namaMilestone}}
Nilai termin: {{nilaiTermin}}
Ringkasan hasil dan bukti: {{ringkasanHasil}}

Dengan ditandatanganinya Berita Acara ini, Pihak Kedua menyatakan hasil pekerjaan telah diterima sesuai ruang lingkup dan spesifikasi kontrak, dan atas dasar BAST ini Pihak Pertama berhak menerbitkan tagihan sesuai termin yang berlaku. Apabila terdapat kekurangan, Pihak Kedua wajib menyampaikannya secara tertulis dalam jangka waktu yang disepakati dalam kontrak.

Pihak Pertama                          Pihak Kedua
{{pihakPertama}}                       {{pihakKedua}}

No. BAST: {{nomorBast}}`,
  },
];

export const templateByCode = (code: string) => TEMPLATES.find((t) => t.code === code) ?? null;
