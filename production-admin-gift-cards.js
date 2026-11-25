import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { createProductionAdminApi, validateProductionAdminConfig } from "./production-admin-api.js?v=order-notifications-1";

const error = document.querySelector("#admin-error");
const success = document.querySelector("#admin-success");
const login = document.querySelector("#admin-login");
const dashboard = document.querySelector("#admin-dashboard");
const config = window.MHT_PRODUCTION_GIFT_CARDS_CONFIG;
const localPreviewNote = document.querySelector("#admin-local-preview-note");
const localPreviewHost = window.location.hostname.toLowerCase();
let auth;
let api;
let orderLoad = 0;
let orderPage = 1;
let salesLoad = 0;
let lastCertificateCode = "";

if (localPreviewNote && ["localhost", "127.0.0.1"].includes(localPreviewHost)) {
  localPreviewNote.textContent = localPreviewHost === "localhost"
    ? "Firebase Authentication allows localhost, but the production Worker intentionally blocks order data and admin actions from local origins."
    : "Firebase Authentication does not allow 127.0.0.1 for this project. Use http://localhost:8765; production Worker data and actions remain restricted to the live website.";
  localPreviewNote.hidden = false;
}

try {
  validateProductionAdminConfig(config);
  const app = initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    appId: config.appId
  }, "mht-production-gift-cards-admin");
  auth = getAuth(app);
  api = createProductionAdminApi(config, auth);
} catch (configurationError) {
  showError(configurationError);
  login.querySelector("button").disabled = true;
}

if (api) {
  onAuthStateChanged(auth, async (user) => {
    clearMessages();
    login.hidden = Boolean(user);
    dashboard.hidden = !user;
    if (!user) return;

    document.querySelector("#admin-identity").textContent =
      `Signed in as ${user.email || "administrator"}`;
    let token;
    try {
      token = await user.getIdTokenResult();
    } catch (requestError) {
      dashboard.hidden = true;
      login.hidden = false;
      showError(requestError);
      return;
    }
    if (token.claims.admin !== true) {
      await signOut(auth);
      showError(new Error("This account is not authorized for gift card administration."));
      return;
    }
    try {
      await loadOrders();
    } catch (requestError) {
      if (["localhost", "127.0.0.1"].includes(localPreviewHost) &&
          requestError instanceof TypeError) {
        login.hidden = true;
        dashboard.hidden = false;
        document.querySelector("#order-list").textContent =
          "Production order data is unavailable in this local preview.";
        showError(new Error(
          "Firebase sign-in succeeded, but the production Worker blocks local origins by design."
        ));
        return;
      }
      dashboard.hidden = true;
      login.hidden = false;
      showError(requestError);
      return;
    }
    try {
      await loadSales();
    } catch (requestError) {
      if (user === auth.currentUser) showError(requestError);
    }
  });

  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();
    const button = login.querySelector("button");
    button.disabled = true;
    try {
      await signInWithEmailAndPassword(
        auth,
        document.querySelector("#admin-email").value.trim(),
        document.querySelector("#admin-password").value
      );
    } catch (requestError) {
      showError(requestError);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#admin-signout").addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (requestError) {
      showError(requestError);
    }
  });
  document.querySelector("#refresh-orders").addEventListener("click", () => loadOrdersWithError(true));
  document.querySelector("#order-filter").addEventListener("change", () => loadOrdersWithError(false, 1));
  document.querySelector("#archive-filter").addEventListener("change", () => loadOrdersWithError(false, 1));
  document.querySelector("#orders-previous").addEventListener("click", () => loadOrdersWithError(false, orderPage - 1));
  document.querySelector("#orders-next").addEventListener("click", () => loadOrdersWithError(false, orderPage + 1));
  document.querySelector("#certificate-search").addEventListener("submit", async (event) => {
    event.preventDefault();
    lastCertificateCode = document.querySelector("#certificate-code").value.trim();
    await lookupCertificate(lastCertificateCode);
  });
}

async function loadOrdersWithError(refreshSales = false, page = orderPage) {
  clearMessages();
  try {
    await Promise.all([loadOrders(page), refreshSales && loadSales()]);
  } catch (requestError) {
    showError(requestError);
  }
}

async function loadOrders(page = orderPage) {
  const request = ++orderLoad;
  const user = auth.currentUser;
  const result = await api.call("listOrders", {
    archive: document.querySelector("#archive-filter").value,
    status: document.querySelector("#order-filter").value,
    page
  });
  if (request !== orderLoad || user !== auth.currentUser) return;
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  if (page > pages) return loadOrders(pages);
  orderPage = page;
  renderOrders(result.orders);
  document.querySelector("#orders-page").textContent = `Page ${page} of ${pages} · ${result.total} orders`;
  document.querySelector("#orders-previous").disabled = page <= 1;
  document.querySelector("#orders-next").disabled = page >= pages;
}

async function loadSales() {
  const request = ++salesLoad;
  const user = auth.currentUser;
  const sales = await api.call("sales");
  if (request !== salesLoad || user !== auth.currentUser) return;

  document.querySelector("#sales-confirmed").textContent = money(sales.confirmedRevenueCents);
  document.querySelector("#sales-promotion").textContent = money(sales.promotionalCreditCents);
  document.querySelector("#sales-this-month").textContent = money(sales.thisMonthRevenueCents);
  document.querySelector("#sales-outstanding").textContent = money(sales.outstandingBalanceCents);
  document.querySelector("#sales-redeemed").textContent = money(sales.totalRedeemedCents);

  const max = Math.max(1, ...sales.monthlyRevenue.map(({ revenueCents }) => revenueCents));
  const monthLabel = new Intl.DateTimeFormat("en-CA", {
    month: "short", year: "numeric", timeZone: "UTC"
  });
  const rows = sales.monthlyRevenue.map(({ month, revenueCents }) => {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = monthLabel.format(new Date(`${month}-01T00:00:00Z`));
    const track = document.createElement("span");
    track.className = "sales-chart-track";
    track.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.style.width = `${100 * revenueCents / max}%`;
    track.append(bar);
    const amount = document.createElement("span");
    amount.textContent = money(revenueCents);
    row.append(label, track, amount);
    return row;
  });
  document.querySelector("#monthly-sales").replaceChildren(...rows);
}

function renderOrders(orders) {
  const list = document.querySelector("#order-list");
  list.replaceChildren();
  if (!orders.length) {
    list.textContent = "No orders in this view.";
    return;
  }

  for (const order of orders) {
    const article = document.createElement("article");
    article.className = "order-card";
    const heading = document.createElement("h3");
    heading.textContent = `${order.order_ref} · ${money(order.amount_cents)}`;
    const details = document.createElement("p");
    details.textContent =
      `${order.purchaser_name} (${order.purchaser_email}) · For ${order.recipient_name} (${order.recipient_email})`;
    const status = document.createElement("p");
    status.className = "muted";
    const paymentStatus = order.payment_status === "payment_reported"
      ? "payment reported — NOT CONFIRMED"
      : order.payment_status.replaceAll("_", " ");
    const balance = order.remaining_balance_cents === null
      ? ""
      : ` · Balance ${money(order.remaining_balance_cents)}`;
    status.textContent =
      `${paymentStatus} · ${order.certificate_status.replaceAll("_", " ")}${balance}`;
    article.append(heading, details, status);

    if (order.payment_reported_at) {
      appendDetail(article, `Customer reported payment ${formatDate(order.payment_reported_at)}`);
    }
    if (order.payment_verified_at) {
      appendDetail(article, `Payment confirmed ${formatDate(order.payment_verified_at)}`);
    }
    if (order.message) appendDetail(article, `Message: ${order.message}`);
    appendDetail(article, `Purchaser email: ${order.order_email_sent_at ? "accepted by Resend" : "not yet accepted"}`);
    appendDetail(article, `Admin notification: ${order.admin_email_sent_at ? "accepted by Resend (delivery not confirmed)" : "not yet accepted"}`);
    if (order.created_at) appendDetail(article, `Ordered ${formatDate(order.created_at)}`);

    const actions = document.createElement("div");
    actions.className = "admin-actions";
    actions.append(actionButton("Resend admin notification", async () => {
      const storageKey = `mhtAdminNotificationResend-${order.id}`;
      let requestId = sessionStorage.getItem(storageKey);
      if (!isUuid(requestId)) {
        requestId = crypto.randomUUID();
        sessionStorage.setItem(storageKey, requestId);
      }
      const result = await api.call("resendAdminNotification", { orderId: order.id, requestId });
      if (result.adminEmailSent) {
        sessionStorage.removeItem(storageKey);
        showMessage("Resend accepted the admin notification. Check Resend for delivery status.");
      } else {
        showError(new Error("The admin notification was not accepted. Retry after checking the email service."));
      }
    }));
    if (order.archived_at) {
      appendDetail(article, `Archived ${formatDate(order.archived_at)}`);
      actions.append(archiveButton(order, false), deleteButton(order));
      article.append(actions);
      list.append(article);
      continue;
    }
    if (order.payment_status === "pending_payment" && order.certificate_status === "not_issued") {
      actions.append(archiveButton(order, true));
    }
    if (order.payment_status !== "paid") {
      actions.append(actionButton("Confirm Payment Received", async () => {
        const confirmation = window.confirm(
          `Confirm that the funds for ${order.order_ref} are visible in the bank account? ` +
          "This will issue and email the valid gift certificate."
        );
        if (!confirmation) return;
        const result = await api.call("confirmPayment", {
          orderId: order.id,
          confirmationNote: ""
        });
        showMessage(paymentResultMessage(result));
      }));
    } else if (order.certificate_status === "not_issued" || !order.payment_email_sent_at) {
      const retryLabel = order.certificate_status === "not_issued"
        ? "Retry certificate issuance"
        : "Retry payment confirmation email";
      actions.append(actionButton(retryLabel, async () => {
        const result = await api.call("confirmPayment", {
          orderId: order.id,
          confirmationNote: order.payment_confirmation_note || ""
        });
        showMessage(paymentResultMessage(result));
      }));
    }
    if (!order.order_email_sent_at || !order.admin_email_sent_at) {
      actions.append(actionButton("Retry order emails", async () => {
        const result = await api.call("retryOrderEmails", { orderId: order.id });
        showMessage(result.confirmationEmailSent && result.adminEmailSent
          ? "Order confirmation and admin notification emails sent."
          : "One or more emails could not be sent. Check the email configuration and retry.");
      }));
    }
    if (order.payment_status === "paid" && order.certificate_status !== "not_issued") {
      actions.append(actionButton("Resend certificate email", async () => {
        const requestId = getCertificateResendRequestId(order.id);
        const result = await api.call("resendCertificate", {
          orderId: order.id,
          requestId
        });
        if (result.emailSent) {
          sessionStorage.removeItem(certificateResendKey(order.id));
          showMessage("Gift certificate email sent.");
        } else {
          showMessage("Certificate is issued, but email delivery failed. Retry to safely attempt delivery again.");
        }
      }));
    }
    actions.append(deleteButton(order));
    article.append(actions);
    list.append(article);
  }
}

function paymentResultMessage(result) {
  const base = result.alreadyConfirmed
    ? "Payment was already confirmed; no duplicate certificate was issued."
    : "Payment confirmed and certificate issuance processed.";
  if (!result.paymentEmailSent || !result.certificateEmailSent) {
    return `${base} One or more emails could not be sent; use the retry actions after checking configuration.`;
  }
  return `${base} Confirmation and certificate emails sent.`;
}

function deleteButton(order) {
  const button = actionButton("Delete test order", async () => {
    const typed = window.prompt(
      `Permanently delete test order ${order.order_ref}? This removes its order, any gift certificate, ` +
      "and any redemption history from the system and sales totals. Any certificate code will stop " +
      "working. Deleting the order does not refund an e-Transfer. Type the order reference to confirm."
    );
    if (typed === null) return false;
    if (typed.trim() !== order.order_ref) throw new Error("The order reference did not match.");
    await api.call("deleteOrder", { orderId: order.id, orderRef: typed.trim(), updatedAt: order.updated_at });
    showMessage("Test order permanently deleted.");
  });
  button.classList.add("order-delete");
  return button;
}

function archiveButton(order, archive) {
  const label = archive ? "Archive order" : "Restore order";
  const effect = archive
    ? "It will move to the archived orders view and its record will be kept."
    : "It will return to the active orders view.";
  return actionButton(label, async () => {
    if (!window.confirm(`${archive ? "Archive" : "Restore"} order ${order.order_ref}? ${effect}`)) {
      return false;
    }
    await api.call(archive ? "archiveOrder" : "restoreOrder", { orderId: order.id });
    showMessage(archive ? "Order archived." : "Order restored.");
  });
}

function actionButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outline";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    clearMessages();
    try {
      if (await action() !== false) await Promise.all([loadOrders(), loadSales()]);
    } catch (requestError) {
      showError(requestError);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

async function lookupCertificate(code) {
  const target = document.querySelector("#certificate-details");
  target.hidden = false;
  target.textContent = "Looking up certificate…";
  clearMessages();
  try {
    const result = await api.call("lookupCertificate", { code });
    renderCertificate(result);
  } catch (requestError) {
    target.replaceChildren();
    showError(requestError);
  }
}

function renderCertificate(result) {
  const target = document.querySelector("#certificate-details");
  target.replaceChildren();
  const certificate = result.certificate;
  const heading = document.createElement("h3");
  heading.textContent = `${certificate.recipientName} · ${money(certificate.balanceCents)} remaining`;
  heading.className = "production-balance";
  const summary = document.createElement("p");
  summary.textContent =
    `Order ${certificate.orderRef} · Original value ${money(certificate.amountCents)} · ${certificate.status.replaceAll("_", " ")}`;
  const recipient = document.createElement("p");
  recipient.textContent = certificate.recipientEmail;
  target.append(heading, summary, recipient);

  if (certificate.balanceCents > 0) {
    const form = createRedemptionForm(certificate);
    target.append(form);
  }

  const historyHeading = document.createElement("h3");
  historyHeading.textContent = "Redemption history";
  const history = document.createElement("ul");
  history.className = "redemption-history";
  for (const redemption of result.redemptions || []) {
    const entry = document.createElement("li");
    entry.className = "production-history-entry";
    entry.textContent =
      `${money(redemption.amountCents)} · Balance ${money(redemption.balanceAfterCents)} · ` +
      `${formatDate(redemption.createdAt)} · Admin ${redemption.redeemedBy}` +
      `${redemption.note ? ` · ${redemption.note}` : ""}`;
    history.append(entry);
  }
  if (!history.childElementCount) {
    const entry = document.createElement("li");
    entry.textContent = "No redemptions yet.";
    history.append(entry);
  }
  target.append(historyHeading, history);
}

function createRedemptionForm(certificate) {
  const form = document.createElement("form");
  form.className = "production-redemption-form";
  const amountLabel = document.createElement("label");
  amountLabel.textContent = "Redeem amount (CAD)";
  const amountInput = document.createElement("input");
  amountInput.name = "amount";
  amountInput.type = "number";
  amountInput.min = "0.01";
  amountInput.max = (certificate.balanceCents / 100).toFixed(2);
  amountInput.step = "0.01";
  amountInput.inputMode = "decimal";
  amountInput.required = true;
  amountLabel.append(amountInput);
  const noteLabel = document.createElement("label");
  noteLabel.textContent = "Transaction note (optional)";
  const noteInput = document.createElement("input");
  noteInput.name = "note";
  noteInput.maxLength = 500;
  noteLabel.append(noteInput);
  const button = document.createElement("button");
  button.className = "solid";
  button.type = "submit";
  button.textContent = "Record redemption";
  form.append(amountLabel, noteLabel, button);

  const storageKey = `mht-production-pending-redemption:${certificate.orderRef}`;
  let pending = readPendingRedemption(storageKey);
  if (pending) {
    amountInput.value = (pending.amountCents / 100).toFixed(2);
    noteInput.value = pending.note;
    amountInput.disabled = true;
    noteInput.disabled = true;
    const retry = document.createElement("p");
    retry.className = "form-note";
    retry.textContent =
      "A previous request may have completed. Retry the same request to confirm its result safely.";
    form.prepend(retry);
    button.textContent = "Retry same redemption";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();
    const amountCents = Math.round(Number(amountInput.value) * 100);
    const note = noteInput.value.trim();
    if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
      showError(new Error("Enter a valid redemption amount."));
      return;
    }
    if (pending && (pending.amountCents !== amountCents || pending.note !== note)) {
      showError(new Error("Retry the pending redemption with the same amount and note."));
      return;
    }
    if (!pending) {
      pending = { requestId: crypto.randomUUID(), amountCents, note };
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
    }
    button.disabled = true;
    try {
      const redemption = await api.call("redeemCertificate", {
        code: lastCertificateCode,
        amountCents,
        note,
        requestId: pending.requestId
      });
      sessionStorage.removeItem(storageKey);
      pending = null;
      const message = redemption.alreadyRedeemed
        ? "This redemption was already recorded; no additional balance was deducted."
        : "Redemption recorded.";
      await lookupCertificate(lastCertificateCode);
      await Promise.all([loadOrders(), loadSales()]);
      showMessage(message);
    } catch (requestError) {
      if (["production/invalid-argument", "production/failed-precondition",
        "production/not-found", "production/already-exists"].includes(requestError.code)) {
        sessionStorage.removeItem(storageKey);
        pending = null;
        amountInput.disabled = false;
        noteInput.disabled = false;
      }
      showError(requestError);
      button.disabled = false;
    }
  });
  return form;
}

function readPendingRedemption(storageKey) {
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(storageKey) || "null");
  } catch {
    sessionStorage.removeItem(storageKey);
    return null;
  }
  if (pending &&
      (!Number.isSafeInteger(pending.amountCents) ||
       pending.amountCents < 1 ||
       typeof pending.note !== "string" ||
       !isUuid(pending.requestId))) {
    sessionStorage.removeItem(storageKey);
    return null;
  }
  return pending;
}

function certificateResendKey(orderId) {
  return `mht-production-certificate-resend:${orderId}`;
}

function getCertificateResendRequestId(orderId) {
  const key = certificateResendKey(orderId);
  const previous = sessionStorage.getItem(key);
  if (isUuid(previous)) return previous;
  const requestId = crypto.randomUUID();
  sessionStorage.setItem(key, requestId);
  return requestId;
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function appendDetail(target, text) {
  const detail = document.createElement("p");
  detail.className = "form-note";
  detail.textContent = text;
  target.append(detail);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function money(cents) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" })
    .format(cents / 100) + " CAD";
}

function clearMessages() {
  error.textContent = "";
  success.textContent = "";
  success.hidden = true;
  error.className = "gift-error production-admin-notice";
}

function showMessage(message) {
  error.textContent = "";
  success.className = "gift-success production-admin-notice";
  success.textContent = message;
  success.hidden = false;
}

function showError(requestError) {
  error.className = "gift-error production-admin-notice";
  error.textContent = requestError.message || "The request could not be completed.";
}
