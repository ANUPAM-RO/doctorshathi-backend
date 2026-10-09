import rateLimit from "express-rate-limit";

const apiWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const apiMax = Number(process.env.RATE_LIMIT_MAX || 100);
const authWindowMs = Number(
  process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000
);
const authMax = Number(process.env.AUTH_RATE_LIMIT_MAX || 10);

const baseOptions = {
  standardHeaders: true,
  legacyHeaders: false,
};

export const apiLimiter = rateLimit({
  ...baseOptions,
  windowMs: apiWindowMs,
  max: apiMax,
  message: { message: "Too many requests, please try again later." },
});

export const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: authWindowMs,
  max: authMax,
  // Only failed attempts (4xx/5xx) count toward the limit.
  skipSuccessfulRequests: true,
  message: { message: "Too many auth attempts, please try again later." },
});
