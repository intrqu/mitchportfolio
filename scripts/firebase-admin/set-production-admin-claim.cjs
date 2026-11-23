const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const projectId = "mht-giftcards-production";

async function main() {
  const [uid, expectedEmail] = process.argv.slice(2);
  if (!uid || !expectedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedEmail)) {
    throw new Error(
      "Usage: npm run set-production-admin-claim -- PRODUCTION_AUTH_UID ADMIN_EMAIL"
    );
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
  if (!user.email || user.email.toLowerCase() !== expectedEmail.toLowerCase() || user.disabled) {
    throw new Error("The requested Firebase user does not match the enabled administrator account.");
  }
  await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true });
  const updatedUser = await auth.getUser(uid);
  if (updatedUser.customClaims?.admin !== true) {
    throw new Error("The production admin claim was not persisted.");
  }
  console.log("Production gift card admin permission granted and verified. Ask the administrator to sign out and back in.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
