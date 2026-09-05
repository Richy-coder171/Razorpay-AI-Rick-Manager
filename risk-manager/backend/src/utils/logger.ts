import pino from 'pino';

// Redact PII/payment fields from structured logs (§4).
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.body.card_hash',
      'req.body.device_fingerprint',
      'req.body.ip_hash',
      '*.card_hash',
      '*.device_fingerprint',
      '*.ip_hash',
      '*.*.card_hash',
      '*.*.device_fingerprint',
      '*.*.ip_hash',
    ],
    censor: '[REDACTED]',
  },
});

export default logger;
