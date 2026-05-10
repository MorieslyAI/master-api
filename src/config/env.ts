import "dotenv/config";

function get(key: string, defaultVal?: string): string {
  const val = process.env[key] ?? defaultVal;
  if (val === undefined) {
    throw new Error(`[env] Missing required environment variable: "${key}"`);
  }
  return val;
}

function formatPrivateKey(key: string): string {
  if (!key) return key;
  let pk = key.replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
  // Jika newlines hilang (Cloud Build sering menghapus newlines dari multiline variable)
  if (!pk.includes("\n") || pk.split("\n").length <= 2) {
    const begin = "-----BEGIN PRIVATE KEY-----";
    const end = "-----END PRIVATE KEY-----";
    if (pk.startsWith(begin) && pk.endsWith(end)) {
      const base64 = pk.substring(begin.length, pk.length - end.length).replace(/\s+/g, "");
      const chunks = base64.match(/.{1,64}/g) || [];
      pk = `${begin}\n${chunks.join("\n")}\n${end}\n`;
    }
  }
  return pk;
}

export const env = {
  NODE_ENV: get("NODE_ENV", "development") as
    | "development"
    | "production"
    | "test",
  PORT: Number(get("PORT", "4000")),
  HOST: get("HOST", "0.0.0.0"),

  // Socket JWT (masih dipakai untuk Gemini Live / WebSocket)
  JWT_SOCKET_SECRET: get("JWT_SOCKET_SECRET"),
  SOCKET_TOKEN_EXPIRES_IN: Number(get("SOCKET_TOKEN_EXPIRES_IN", "60")),

  // Cookie refresh token TTL (untuk maxAge cookie, bukan TTL Firebase)
  REFRESH_TOKEN_TTL_DAYS: Number(get("REFRESH_TOKEN_TTL_DAYS", "30")),

  // Firebase Admin SDK
  FIREBASE_PROJECT_ID: get("FIREBASE_PROJECT_ID"),
  FIREBASE_CLIENT_EMAIL: get("FIREBASE_CLIENT_EMAIL"),
  FIREBASE_PRIVATE_KEY: formatPrivateKey(get("FIREBASE_PRIVATE_KEY")),

  // Firebase Auth REST API key (dari Firebase Console → Project Settings → Web API Key)
  FIREBASE_API_KEY: get("FIREBASE_API_KEY"),

  // Gemini API Key for Scan
  GEMINI_API_KEY: get("GEMINI_API_KEY"),

  // Video call defaults (dynamic override can be stored in users/{uid}.videoPolicy)
  VIDEO_CALL_MAX_DURATION_SECONDS: Number(
    get("VIDEO_CALL_MAX_DURATION_SECONDS", "900"),
  ),
  VIDEO_CALL_DAILY_MAX_CALLS: Number(get("VIDEO_CALL_DAILY_MAX_CALLS", "5")),
  VIDEO_CALL_DAILY_MAX_SECONDS: Number(
    get("VIDEO_CALL_DAILY_MAX_SECONDS", "3600"),
  ),
  VIDEO_CALL_MAX_CONCURRENT_PER_USER: Number(
    get("VIDEO_CALL_MAX_CONCURRENT_PER_USER", "1"),
  ),
  VIDEO_CALL_GLOBAL_MAX_CONCURRENT: Number(
    get("VIDEO_CALL_GLOBAL_MAX_CONCURRENT", "500"),
  ),

  // CORS
  // Bisa single origin atau comma-separated list.
  // Contoh:
  //   CORS_ORIGIN=http://localhost:3000,https://localhost,capacitor://localhost
  CORS_ORIGIN: get("CORS_ORIGIN", "http://localhost:3000"),
} as const;

export type Env = typeof env;
