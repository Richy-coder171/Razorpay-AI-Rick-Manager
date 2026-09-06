import dotenv from 'dotenv';

dotenv.config();

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface AppConfig {
  port: number;
  env: string;
  db_driver: 'mongo' | 'file';
  mongo_uri: string;
  data_dir: string;
  llm_provider: 'gemini' | 'mock';
  gemini_api_key: string;
  gemini_model: string;
  llm_timeout_ms: number;
  detector_timeout_ms: number;
  payment_provider: 'mock' | 'razorpay';
  razorpay_key_id: string;
  razorpay_key_secret: string;
  razorpay_webhook_secret: string;
  demo_api_key: string;
  require_api_key: boolean;
  cors_origins: string[];
}

export function loadConfig(): AppConfig {
  return {
    port: intEnv('PORT', 3001),
    env: process.env.NODE_ENV || 'development',
    db_driver: (process.env.DB_DRIVER as 'mongo' | 'file') || 'file',
    mongo_uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/risk-manager',
    data_dir: process.env.DATA_DIR || './data',
    llm_provider: (process.env.LLM_PROVIDER as 'gemini' | 'mock') || 'mock',
    // Gemini (Google AI Studio key). Uses Gemini's OpenAI-compatible endpoint,
    // so the provider is a plain chat/completions request. Any model name
    // from https://generativelanguage.googleapis.com works via GEMINI_MODEL.
    gemini_api_key: process.env.GEMINI_API_KEY || '',
    gemini_model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    llm_timeout_ms: intEnv('LLM_TIMEOUT_MS', 15000),
    detector_timeout_ms: intEnv('DETECTOR_TIMEOUT_MS', 5000),
    payment_provider: (process.env.PAYMENT_PROVIDER as 'mock' | 'razorpay') || 'mock',
    razorpay_key_id: process.env.RAZORPAY_KEY_ID || '',
    razorpay_key_secret: process.env.RAZORPAY_KEY_SECRET || '',
    razorpay_webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    demo_api_key: process.env.DEMO_API_KEY || 'demo-key',
    require_api_key: process.env.REQUIRE_API_KEY !== 'false',
    cors_origins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export const config = loadConfig();
