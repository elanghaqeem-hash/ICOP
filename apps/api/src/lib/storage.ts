import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { Sql } from '../db.js';
import { getIntegration } from './integrations.js';

/**
 * Lapisan storage dokumen. Disk lokal = cache kerja (OCR/kompresi butuh file lokal).
 * Bila integrasi STORAGE_S3 aktif: setiap file direplikasi ke bucket (SSE AES256) dan dibaca ulang dari bucket bila salinan lokal hilang.
 */
interface S3Cfg { endpoint?: string; region: string; bucket: string; prefix?: string; forcePathStyle?: boolean }
interface S3Sec { accessKeyId: string; secretAccessKey: string }

export function s3ClientFor(cfg: S3Cfg, sec: S3Sec) {
  return new S3Client({ region: cfg.region, endpoint: cfg.endpoint || undefined, forcePathStyle: cfg.forcePathStyle ?? true,
    credentials: { accessKeyId: sec.accessKeyId, secretAccessKey: sec.secretAccessKey } });
}

async function activeS3(sql: Sql | any, tenantId: string) {
  const it = await getIntegration<S3Cfg, S3Sec>(sql, tenantId, 'STORAGE_S3');
  if (!it || !it.enabled || !it.secrets.accessKeyId) return null;
  return { client: s3ClientFor(it.config, it.secrets), cfg: it.config };
}

/** Kunci objek: <prefix><tenant>/<path setelah segmen tenant>. */
export function objectKeyFor(tenantId: string, localPath: string, prefix = '') {
  const idx = localPath.indexOf(`/${tenantId}/`);
  const rest = idx >= 0 ? localPath.slice(idx + tenantId.length + 2) : basename(localPath);
  const area = localPath.includes('/documents/') ? 'documents' : 'files';
  return `${prefix}${tenantId}/${area}/${rest}`;
}

/** Tulis file (lokal) lalu replikasi ke S3 bila aktif. Gagal replikasi tidak menggagalkan unggahan (disinkronkan ulang). */
export async function storeFile(sql: Sql | any, tenantId: string, localPath: string, buf: Buffer, log?: { warn: (o: unknown, m: string) => void }) {
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, buf, { mode: 0o600 });
  try { await replicate(sql, tenantId, localPath, buf); } catch (e) { log?.warn({ err: (e as Error).message, localPath }, 'replikasi S3 gagal — akan disinkronkan ulang'); }
}

async function replicate(sql: Sql | any, tenantId: string, localPath: string, buf: Buffer) {
  const s3 = await activeS3(sql, tenantId);
  if (!s3) return false;
  const key = objectKeyFor(tenantId, localPath, s3.cfg.prefix);
  const sha = createHash('sha256').update(buf).digest('hex');
  await s3.client.send(new PutObjectCommand({ Bucket: s3.cfg.bucket, Key: key, Body: buf, ServerSideEncryption: 'AES256', Metadata: { sha256: sha } }));
  await sql`INSERT INTO storage_objects (tenant_id, object_key, size_bytes, sha256) VALUES (${tenantId}, ${key}, ${buf.length}, ${sha})
            ON CONFLICT (tenant_id, object_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, replicated_at = now()`;
  return true;
}

/** Baca file: lokal dulu; bila hilang dan S3 aktif → unduh dari bucket lalu simpan ulang ke cache lokal. */
export async function readStoredFile(sql: Sql | any, tenantId: string, localPath: string): Promise<Buffer> {
  try { return await readFile(localPath); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const s3 = await activeS3(sql, tenantId);
    if (!s3) throw e;
    const out = await s3.client.send(new GetObjectCommand({ Bucket: s3.cfg.bucket, Key: objectKeyFor(tenantId, localPath, s3.cfg.prefix) }));
    const buf = Buffer.from(await out.Body!.transformToByteArray());
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, buf, { mode: 0o600 });
    return buf;
  }
}

/** Uji koneksi: HeadBucket + tulis/baca/hapus objek uji. */
export async function testStorage(cfg: S3Cfg, sec: S3Sec) {
  const c = s3ClientFor(cfg, sec);
  await c.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
  const key = `${cfg.prefix ?? ''}_icop_healthcheck_${Date.now()}`;
  await c.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: 'ok', ServerSideEncryption: 'AES256' }));
  const g = await c.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  const body = await g.Body!.transformToString();
  await c.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  if (body !== 'ok') throw new Error('Isi objek uji tidak cocok');
  return { ok: true };
}

/** Sinkronisasi file lama yang belum direplikasi (dokumen, hasil kompresi, dokumen tender). */
export async function syncExisting(sql: Sql | any, tenantId: string) {
  const s3 = await activeS3(sql, tenantId);
  if (!s3) return { uploaded: 0, missingLocal: 0, skipped: 0, enabled: false };
  const paths = await sql`SELECT original_path AS p FROM documents WHERE tenant_id = ${tenantId}
                          UNION SELECT stored_path FROM documents WHERE tenant_id = ${tenantId} AND stored_path IS NOT NULL
                          UNION SELECT storage_path FROM tender_documents WHERE tenant_id = ${tenantId} AND storage_path IS NOT NULL`;
  const done = new Set((await sql`SELECT object_key FROM storage_objects WHERE tenant_id = ${tenantId}`).map((r: any) => r.objectKey as string));
  let uploaded = 0; let missingLocal = 0; let skipped = 0;
  for (const { p } of paths) {
    if (!p) continue;
    if (done.has(objectKeyFor(tenantId, p as string, s3.cfg.prefix))) { skipped++; continue; }
    try { await access(p as string); } catch { missingLocal++; continue; }
    await replicate(sql, tenantId, p as string, await readFile(p as string));
    uploaded++;
  }
  return { uploaded, missingLocal, skipped, enabled: true };
}
