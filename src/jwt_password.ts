import "./env.ts";

const val = process.env.JWT_PASSWORD || process.env.JWT_SECRET;
if (!val) {
  throw new Error("JWT_PASSWORD or JWT_SECRET is not defined in environment variables");
}
export const JWT_PASSWORD = val;