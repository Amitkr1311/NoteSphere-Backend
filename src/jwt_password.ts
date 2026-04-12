import "./env.ts";

const val = process.env.JWT_PASSWORD;
if (!val) {
  throw new Error("JWT_PASSWORD is not defined in environment variables");
}
export const JWT_PASSWORD = val;