const admin = require("firebase-admin");
const projectId = "mht-giftcards-staging";

async function main() {
  const uid = process.argv[2];
  if (!uid) {
    throw new Error("Usage: npm run set-admin-claim -- STAGING_FIREBASE_AUTH_UID");
  }
  const app = admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId
  });
  if (app.options.projectId !== projectId) {
    throw new Error(`Refusing to set admin claims outside ${projectId}.`);
  }
  const auth = admin.auth(app);
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true });
  console.log(`Staging gift card admin permission granted to ${uid}. Ask them to sign out and back in.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
