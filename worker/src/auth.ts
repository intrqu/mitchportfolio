import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AdminIdentity } from "./types.js";

const firebaseSigningKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

export async function verifyFirebaseAdminToken(
  token: string,
  projectId: string,
  keySet: JWTVerifyGetKey = firebaseSigningKeys
): Promise<AdminIdentity> {
  const { payload } = await jwtVerify(token, keySet, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
    maxTokenAge: "1 hour"
  });
  if (typeof payload.sub !== "string" || payload.sub.length < 1 || payload.sub.length > 128) {
    throw new Error("The Firebase token has no valid user ID.");
  }
  return {
    uid: payload.sub,
    admin: payload.admin === true,
    email: typeof payload.email === "string" ? payload.email.toLowerCase() : undefined
  };
}
