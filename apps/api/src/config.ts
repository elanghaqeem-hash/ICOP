import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v.trim() === '') throw new Error(`Missing env ${name}`);
  return v;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';
const jwtSecret = req('JWT_SECRET', isProduction ? undefined : 'dev-only-secret-change-me-min-32-characters!!');
if (isProduction && (jwtSecret.length < 32 || jwtSecret === 'ganti-dengan-string-acak-minimal-32-karakter')) {
  throw new Error('JWT_SECRET must be a unique secret of at least 32 characters in production');
}

// A database without explicit credentials must never silently start in production.
const databaseUrl = process.env.DATABASE_URL ||
  `postgres://${process.env.DB_USER ?? 'icop_app'}:${encodeURIComponent(req('DB_PASSWORD', isProduction ? undefined : 'icop_dev_password_2026'))}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? 5432}/${process.env.DB_NAME ?? 'icop'}`;

// The backend is private by default. Enable only when every upstream hop is trusted,
// and never expose port 3001 publicly when TRUST_PROXY=true.
const trustProxy = process.env.TRUST_PROXY === 'true';
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (isProduction && (allowedOrigins.length === 0 || allowedOrigins.includes('*'))) {
  throw new Error('ALLOWED_ORIGINS must list explicit origins in production');
}

export const config = {
  nodeEnv,
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  jwtSecret,
  jwtTtl: process.env.JWT_TTL ?? '8h',
  trustProxy,
  swaggerUiEnabled: process.env.API_DOCS_ENABLED === 'true' || (!isProduction && process.env.API_DOCS_ENABLED !== 'false'),
  allowedOrigins,
  databaseUrl,
  aiDefaultTimeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30000),
};
