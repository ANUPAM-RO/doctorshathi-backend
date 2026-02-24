import rateLimit from "express-rate-limit";

const apiWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 1 * 60 * 1000);
const apiMax = Number(process.env.RATE_LIMIT_MAX || 100);
const authWindowMs = Number(
  process.env.AUTH_RATE_LIMIT_WINDOW_MS || 1 * 60 * 1000
);
const authMax = Number(process.env.AUTH_RATE_LIMIT_MAX || 50);

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
  message: { message: "Too many auth attempts, please try again later." },
});
