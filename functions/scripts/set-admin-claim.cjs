const admin = require("firebase-admin");

async function main() {
  const uid = process.argv[2];
  if (!uid) {
    throw new Error("Usage: node functions/scripts/set-admin-claim.cjs FIREBASE_AUTH_UID");
  }
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const auth = admin.auth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true });
  console.log(`Gift card admin permission granted to ${uid}. Ask them to sign out and back in.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
