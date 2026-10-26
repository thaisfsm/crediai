import "server-only";
import { randomBytes } from "node:crypto";
export const newLinkToken = () => randomBytes(24).toString("base64url");
