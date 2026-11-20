import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const error = document.querySelector("#admin-error");
const login = document.querySelector("#admin-login");
const dashboard = document.querySelector("#admin-dashboard");
const config = window.MHT_FIREBASE_CONFIG;

if (config?.apiKey?.startsWith("REPLACE_") || !config?.workerApiBaseUrl) {
  error.textContent = "Staging administration is not configured. See the gift card setup instructions.";
  login.querySelector("button").disabled = true;
} else {
  const workerApiBaseUrl = config.workerApiBaseUrl;
  const app = initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    appId: config.appId
  });
  const auth = getAuth(app);
  const call = async (name, data = {}) => {
    const user = auth.currentUser;
    if (!user) throw new Error("Sign in to continue.");
    const routes = {
      listGiftCardOrders: { method: "GET", path: "/api/admin/orders" },
      simulateStagingPayment: { method: "POST", path: `/api/admin/orders/${encodeURIComponent(data.orderId)}/simulate-payment` },
      retryGiftCardOrderEmails: { method: "POST", path: `/api/admin/orders/${encodeURIComponent(data.orderId)}/retry-order-emails` },
      issueGiftCertificate: { method: "POST", path: `/api/admin/orders/${encodeURIComponent(data.orderId)}/issue` },
      resendGiftCertificate: { method: "POST", path: `/api/admin/orders/${encodeURIComponent(data.orderId)}/resend` },
      lookupGiftCertificate: { method: "POST", path: "/api/admin/certificates/lookup" },
      redeemGiftCertificate: { method: "POST", path: "/api/admin/certificates/redeem" }
    };
    const route = routes[name];
    if (!route) throw new Error("This administration action is not available.");
    const url = new URL(`${workerApiBaseUrl}${route.path}`);
    if (name === "listGiftCardOrders" && data.cursor) url.searchParams.set("cursor", data.cursor);
    const response = await fetch(url, {
      method: route.method,
      headers: {
        Authorization: `Bearer ${await user.getIdToken()}`,
        "Content-Type": "application/json"
      },
      body: route.method === "POST" ? JSON.stringify(data) : undefined
    });
    const result = await response.json();
    if (!response.ok) {
      const requestError = new Error(result?.error || "The request could not be completed.");
      requestError.code = `functions/${result?.code || "internal"}`;
      throw requestError;
    }
    return result;
  };
  let orders = [];
  let orderCursor = null;
  let lastCertificateCode = "";

  let rejectedAdminSignIn = false;
  onAuthStateChanged(auth, async (user) => {
    error.textContent = "";
    login.hidden = Boolean(user);
    dashboard.hidden = !user;
    if (!user) {
      if (rejectedAdminSignIn) {
        error.textContent = "This account is not authorized for gift card administration.";
        rejectedAdminSignIn = false;
      }
      return;
    }
    document.querySelector("#admin-identity").textContent = `Signed in as ${user.email || "administrator"}`;
    try {
      const token = await user.getIdTokenResult();
      if (token.claims.admin !== true) {
        rejectedAdminSignIn = true;
        await signOut(auth);
        return;
      }
      await loadOrders();
    } catch (requestError) {
      dashboard.hidden = true;
      login.hidden = false;
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
      if (filter === "pending") return order.paymentStatus === "pending_payment";
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
      const paymentStatus = order.paymentStatus === "paid" ? "test payment simulated" : order.paymentStatus.replaceAll("_", " ");
      status.textContent = `${paymentStatus} · ${order.certificateStatus.replaceAll("_", " ")}${order.remainingBalanceCents === null ? "" : ` · Balance ${money(order.remainingBalanceCents)}`} · VOID — TEST ONLY`;
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
      if (!order.orderEmailSentAt || !order.adminEmailSentAt) {
        actions.append(actionButton("Retry test order emails", async () => {
          const result = await call("retryGiftCardOrderEmails", { orderId: order.id });
          showMessage(result.confirmationEmailSent && result.adminEmailSent
            ? "Order and admin notification emails sent."
            : "One or more order emails could not be sent. Check staging email configuration.");
        }));
      }
      if (order.paymentStatus === "pending_payment") {
        actions.append(actionButton("Simulate payment and issue (VOID — TEST ONLY)", async () => {
          if (!window.confirm(`Simulate a test payment for ${order.orderRef}? No money will be received and the certificate will be void.`)) return;
          const result = await call("simulateStagingPayment", { orderId: order.id });
          if (result.alreadyConfirmed) {
            showMessage("Test payment was already simulated. No additional certificate was created.");
            return;
          }
          showMessage(result.emailSent && result.confirmationEmailSent
            ? "Test payment simulated; void certificate issued and test emails sent."
            : "Test payment simulated and void certificate issued, but one or more test emails failed.");
        }));
      } else if (order.paymentStatus === "paid" && order.certificateStatus === "not_issued") {
        actions.append(actionButton("Issue test certificate (VOID — TEST ONLY)", async () => {
          const result = await call("issueGiftCertificate", { orderId: order.id });
          showMessage(result.emailSent
            ? "Void test certificate issued and emailed."
            : "Void test certificate issued, but test email delivery failed.");
        }));
      } else if (order.paymentStatus === "paid") {
        if (!order.paymentConfirmationEmailSent) {
          actions.append(actionButton("Retry test payment and certificate emails", async () => {
            const result = await call("simulateStagingPayment", { orderId: order.id });
            showMessage(result.confirmationEmailSent && result.emailSent
              ? "Test payment and void certificate emails sent."
              : "One or more test emails could not be sent. Check configuration and retry.");
          }));
        }
        actions.append(actionButton("Resend certificate", async () => {
          const deliveryKey = `mht-certificate-resend-${order.id}`;
          const requestId = sessionStorage.getItem(deliveryKey) || crypto.randomUUID();
          sessionStorage.setItem(deliveryKey, requestId);
          const result = await call("resendGiftCertificate", { orderId: order.id, requestId });
          if (result.emailSent) sessionStorage.removeItem(deliveryKey);
          showMessage(result.emailSent
            ? "Void test certificate resent."
            : "Void test certificate could not be emailed. Check staging email configuration.");
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
        const notice = error.textContent;
        const noticeClass = error.className;
        await loadOrders();
        if (notice) {
          error.className = noticeClass;
          error.textContent = notice;
        }
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
    heading.textContent = `${certificate.recipientName} · ${money(certificate.balanceCents)} remaining · VOID — TEST ONLY`;
    const summary = document.createElement("p");
    summary.textContent = `Order ${certificate.orderRef} · Original value ${money(certificate.amountCents)} · ${certificate.status.replaceAll("_", " ")} · Test-only balance simulation`;
    const recipient = document.createElement("p");
    recipient.textContent = certificate.recipientEmail;
    target.append(heading, summary, recipient);

    const redemptionForm = document.createElement("form");
    redemptionForm.className = "admin-inline";
    redemptionForm.innerHTML = `<label>Simulate redemption amount (CAD)<input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required></label>
      <label>Note (optional)<input name="note" maxlength="500"></label><button class="solid" type="submit">Record test redemption</button>`;
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
        const notice = result.alreadyRedeemed
          ? "This redemption was already recorded; no additional balance was deducted."
          : "Redemption recorded.";
        await lookupCertificate(lastCertificateCode);
        await loadOrders();
        showMessage(notice);
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
