import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const error = document.querySelector("#admin-error");
const login = document.querySelector("#admin-login");
const dashboard = document.querySelector("#admin-dashboard");

if (window.MHT_FIREBASE_CONFIG?.apiKey?.startsWith("REPLACE_") ||
    window.MHT_FIREBASE_CONFIG?.appCheckSiteKey?.startsWith("REPLACE_")) {
  error.textContent = "Firebase is not configured. See the gift card setup instructions.";
  login.querySelector("button").disabled = true;
} else {
  const app = initializeApp(window.MHT_FIREBASE_CONFIG);
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(window.MHT_FIREBASE_CONFIG.appCheckSiteKey),
    isTokenAutoRefreshEnabled: true
  });
  const auth = getAuth(app);
  const functions = getFunctions(app, "us-west1");
  const call = (name, data = {}) => httpsCallable(functions, name)(data).then((result) => result.data);
  let orders = [];
  let orderCursor = null;
  let lastCertificateCode = "";

  onAuthStateChanged(auth, async (user) => {
    error.textContent = "";
    login.hidden = Boolean(user);
    dashboard.hidden = !user;
    if (!user) return;
    document.querySelector("#admin-identity").textContent = `Signed in as ${user.email || "administrator"}`;
    try {
      await loadOrders();
    } catch (requestError) {
      error.textContent = requestError.message || "Could not load gift card orders.";
    }
  });

  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      await signInWithEmailAndPassword(auth,
        document.querySelector("#admin-email").value.trim(),
        document.querySelector("#admin-password").value);
    } catch (requestError) {
      error.textContent = requestError.message || "Sign-in failed.";
    }
  });
  document.querySelector("#admin-signout").addEventListener("click", () => signOut(auth));
  document.querySelector("#refresh-orders").addEventListener("click", loadOrdersWithError);
  document.querySelector("#load-more-orders").addEventListener("click", async () => {
    try { await loadOrders(false); }
    catch (requestError) { showError(requestError); }
  });
  document.querySelector("#order-filter").addEventListener("change", renderOrders);
  document.querySelector("#certificate-search").addEventListener("submit", async (event) => {
    event.preventDefault();
    lastCertificateCode = document.querySelector("#certificate-code").value.trim();
    await lookupCertificate(lastCertificateCode);
  });

  async function loadOrdersWithError() {
    try { await loadOrders(); }
    catch (requestError) { showError(requestError); }
  }

  async function loadOrders(reset = true) {
    error.textContent = "";
    if (reset) {
      orders = [];
      orderCursor = null;
    }
    const result = await call("listGiftCardOrders", { cursor: orderCursor });
    orders = orders.concat(result.orders);
    orderCursor = result.nextCursor;
    renderOrders();
    document.querySelector("#load-more-orders").hidden = !orderCursor;
  }

  function renderOrders() {
    const list = document.querySelector("#order-list");
    list.replaceChildren();
    const filter = document.querySelector("#order-filter").value;
    const visibleOrders = orders.filter((order) => {
      if (filter === "pending") return order.paymentStatus === "pending_payment" || order.paymentStatus === "payment_reported";
      if (filter === "paid") return order.paymentStatus === "paid" && order.certificateStatus === "not_issued";
      if (filter === "issued") return order.certificateStatus === "issued";
      if (filter === "partial") return order.certificateStatus === "partially_redeemed";
      if (filter === "redeemed") return order.certificateStatus === "redeemed";
      return true;
    });
    if (!visibleOrders.length) {
      list.textContent = "No orders in this view.";
      return;
    }
    for (const order of visibleOrders) {
      const article = document.createElement("article");
      article.className = "order-card";
      const heading = document.createElement("h3");
      heading.textContent = `${order.orderRef} · ${money(order.amountCents)}`;
      const details = document.createElement("p");
      details.textContent = `${order.purchaserName} (${order.purchaserEmail}) · For ${order.recipientName} (${order.recipientEmail})`;
      const status = document.createElement("p");
      status.className = "muted";
      status.textContent = `${order.paymentStatus.replaceAll("_", " ")} · ${order.certificateStatus.replaceAll("_", " ")}${order.remainingBalanceCents === null ? "" : ` · Balance ${money(order.remainingBalanceCents)}`}`;
      article.append(heading, details, status);
      if (order.message) {
        const message = document.createElement("p");
        message.textContent = `Message: ${order.message}`;
        article.append(message);
      }
      if (order.createdAt) {
        const date = document.createElement("p");
        date.className = "form-note";
        date.textContent = `Ordered ${new Date(order.createdAt).toLocaleString()}`;
        article.append(date);
      }
      const actions = document.createElement("div");
      actions.className = "admin-actions";
      if (order.paymentStatus === "pending_payment" || order.paymentStatus === "payment_reported") {
        actions.append(actionButton("Confirm payment and issue", async () => {
          if (!window.confirm(`Confirm that ${money(order.amountCents)} for ${order.orderRef} has arrived in the bank account?`)) return;
          const result = await call("confirmInteracPayment", { orderId: order.id });
          if (result.alreadyConfirmed) {
            showMessage("Payment was already confirmed. No additional certificate was created.");
            return;
          }
          showMessage(result.emailSent && result.confirmationEmailSent
            ? "Payment confirmed; certificate issued and emails sent."
            : "Payment confirmed and certificate issued, but one or more emails failed. Use Resend after checking email configuration.");
        }));
      } else if (order.paymentStatus === "paid" && order.certificateStatus === "not_issued") {
        actions.append(actionButton("Issue certificate", async () => {
          const result = await call("issueGiftCertificate", { orderId: order.id });
          showMessage(result.emailSent ? "Certificate issued and emailed." : "Certificate issued, but email delivery failed. Check email configuration and resend.");
        }));
      } else if (order.paymentStatus === "paid") {
        if (!order.paymentConfirmationEmailSent) {
          actions.append(actionButton("Retry payment confirmation email", async () => {
            const result = await call("confirmInteracPayment", { orderId: order.id });
            showMessage(result.confirmationEmailSent
              ? "Payment confirmation email sent."
              : "Payment confirmation email could not be sent. Check email configuration and retry.");
          }));
        }
        actions.append(actionButton("Resend certificate", async () => {
          const deliveryKey = `mht-certificate-resend-${order.id}`;
          const requestId = sessionStorage.getItem(deliveryKey) || crypto.randomUUID();
          sessionStorage.setItem(deliveryKey, requestId);
          const result = await call("resendGiftCertificate", { orderId: order.id, requestId });
          if (result.emailSent) sessionStorage.removeItem(deliveryKey);
          showMessage(result.emailSent ? "Certificate resent." : "Certificate could not be emailed. Check email configuration.");
        }));
      }
      if (actions.childElementCount) article.append(actions);
      list.append(article);
    }
  }

  function actionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "outline";
    button.textContent = label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      error.textContent = "";
      try {
        await action();
        await loadOrders();
      } catch (requestError) {
        showError(requestError);
        button.disabled = false;
      }
    });
    return button;
  }

  async function lookupCertificate(code) {
    const target = document.querySelector("#certificate-details");
    target.hidden = false;
    target.textContent = "Looking up certificate…";
    error.textContent = "";
    try {
      const result = await call("lookupGiftCertificate", { code });
      renderCertificate(result);
    } catch (requestError) {
      target.textContent = "";
      showError(requestError);
    }
  }

  function renderCertificate(result) {
    const target = document.querySelector("#certificate-details");
    target.replaceChildren();
    const certificate = result.certificate;
    const heading = document.createElement("h3");
    heading.textContent = `${certificate.recipientName} · ${money(certificate.balanceCents)} remaining`;
    const summary = document.createElement("p");
    summary.textContent = `Order ${certificate.orderRef} · Original value ${money(certificate.amountCents)} · ${certificate.status.replaceAll("_", " ")}`;
    const recipient = document.createElement("p");
    recipient.textContent = certificate.recipientEmail;
    target.append(heading, summary, recipient);

    const redemptionForm = document.createElement("form");
    redemptionForm.className = "admin-inline";
    redemptionForm.innerHTML = `<label>Redeem amount (CAD)<input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required></label>
      <label>Note (optional)<input name="note" maxlength="500"></label><button class="solid" type="submit">Redeem</button>`;
    const pendingKey = `mht-pending-redemption-${certificate.orderRef}`;
    let pendingRequest = null;
    try {
      pendingRequest = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
    } catch {
      sessionStorage.removeItem(pendingKey);
    }
    if (pendingRequest &&
        (!Number.isSafeInteger(pendingRequest.amountCents) ||
         typeof pendingRequest.note !== "string" ||
         !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pendingRequest.requestId))) {
      sessionStorage.removeItem(pendingKey);
      pendingRequest = null;
    }
    if (pendingRequest) {
      redemptionForm.elements.amount.value = (pendingRequest.amountCents / 100).toFixed(2);
      redemptionForm.elements.note.value = pendingRequest.note;
      redemptionForm.elements.amount.disabled = true;
      redemptionForm.elements.note.disabled = true;
      const retryNote = document.createElement("p");
      retryNote.className = "form-note";
      retryNote.textContent = "A prior redemption request may have completed. Retry this same request to safely confirm its result.";
      redemptionForm.prepend(retryNote);
    }
    redemptionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const amountCents = Math.round(Number(redemptionForm.elements.amount.value) * 100);
      if (!Number.isSafeInteger(amountCents) || amountCents < 1) return;
      const button = redemptionForm.querySelector("button");
      button.disabled = true;
      try {
        const note = redemptionForm.elements.note.value.trim();
        if (pendingRequest &&
            (pendingRequest.amountCents !== amountCents || pendingRequest.note !== note)) {
          throw new Error("Retry the pending redemption with the same amount and note before starting another redemption.");
        }
        if (!pendingRequest) {
          pendingRequest = {
            requestId: crypto.randomUUID(),
            amountCents,
            note
          };
          sessionStorage.setItem(pendingKey, JSON.stringify(pendingRequest));
        }
        const result = await call("redeemGiftCertificate", {
          code: lastCertificateCode,
          amountCents,
          note,
          requestId: pendingRequest.requestId
        });
        sessionStorage.removeItem(pendingKey);
        showMessage(result.alreadyRedeemed
          ? "This redemption was already recorded; no additional balance was deducted."
          : "Redemption recorded.");
        await lookupCertificate(lastCertificateCode);
        await loadOrders();
      } catch (requestError) {
        if (["functions/invalid-argument", "functions/failed-precondition", "functions/not-found"]
          .includes(requestError.code)) {
          sessionStorage.removeItem(pendingKey);
          pendingRequest = null;
          redemptionForm.elements.amount.disabled = false;
          redemptionForm.elements.note.disabled = false;
        }
        showError(requestError);
        button.disabled = false;
      }
    });
    target.append(redemptionForm);

    const historyHeading = document.createElement("h3");
    historyHeading.textContent = "Redemption history";
    const history = document.createElement("ul");
    history.className = "redemption-history";
    for (const redemption of result.redemptions) {
      const entry = document.createElement("li");
      entry.textContent = `${money(redemption.amountCents)} · ${redemption.createdAt ? new Date(redemption.createdAt).toLocaleString() : "Date unavailable"}${redemption.note ? ` · ${redemption.note}` : ""}`;
      history.append(entry);
    }
    if (!result.redemptions.length) {
      const entry = document.createElement("li");
      entry.textContent = "No redemptions yet.";
      history.append(entry);
    }
    target.append(historyHeading, history);
  }

  function showMessage(message) {
    error.className = "gift-success";
    error.textContent = message;
  }

  function showError(requestError) {
    error.className = "gift-error";
    error.textContent = requestError.message || "The request could not be completed.";
  }

  function money(cents) {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100) + " CAD";
  }
}
