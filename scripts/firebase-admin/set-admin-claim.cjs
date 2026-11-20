const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const projectId = "mht-giftcards-staging";

async function main() {
  const uid = process.argv[2];
  if (!uid) {
    throw new Error("Usage: npm run set-admin-claim -- STAGING_FIREBASE_AUTH_UID");
  }
  const app = initializeApp({
    credential: applicationDefault(),
    projectId
  });
  if (app.options.projectId !== projectId) {
    throw new Error(`Refusing to set admin claims outside ${projectId}.`);
  }
  const auth = getAuth(app);
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true });
  const updatedUser = await auth.getUser(uid);
  if (updatedUser.customClaims?.admin !== true) {
    throw new Error("The staging admin claim was not persisted.");
  }
  console.log(`Staging gift card admin permission granted and verified for ${uid}. Ask them to sign out and back in.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
