import { validateProductionAdminConfig } from "./production-admin-api.js";

const PRODUCTION_SITE_ORIGIN = "https://mitchharschtattoo.com";
const form = document.querySelector("#gift-order");
const customAmount = document.querySelector("#custom-amount");
const total = document.querySelector("#total");
const recipientDetails = document.querySelector("#recipient-details");
const recipientName = document.querySelector("#recipient-name");
const recipientEmail = document.querySelector("#recipient-email");
const error = document.querySelector("#order-error");
const statusHeading = document.querySelector("#order-status-heading");
const statusCopy = document.querySelector("#order-status-copy");
const submitNote = document.querySelector("#production-submit-note");
const submitButton = document.querySelector("#submit-order");
const turnstileTarget = document.querySelector("#order-turnstile");
const orderResult = document.querySelector("#order-result");
const orderTokenKey = "mhtProductionGiftCardPendingOrderToken";
const orderRequestKey = "mhtProductionGiftCardPendingOrderRequest";
const activeOrderKey = "mhtProductionGiftCardOrder";

const config = window.MHT_PRODUCTION_GIFT_CARDS_CONFIG;
let workerApiBaseUrl = "";
let orderingEnabled = false;
let turnstileWidget = null;
let turnstileToken = "";
let activeOrder = null;
let submitting = false;

function selectedAmount() {
  if (customAmount.value !== "") return Math.round(Number(customAmount.value) * 100);
  return Number(form.querySelector('input[name="preset"]:checked')?.value || 0);
}

function updateTotal() {
  const cents = selectedAmount();
  total.textContent = Number.isSafeInteger(cents) && cents > 0
    ? `${formatCurrency(cents)} CAD`
    : "Enter an amount";
}

function setUnavailable(heading, message) {
  orderingEnabled = false;
  submitButton.disabled = true;
  submitButton.textContent = "Ordering unavailable";
  turnstileTarget.hidden = true;
  statusHeading.textContent = heading;
  statusCopy.textContent = message;
  submitNote.textContent = "No payment is accepted. Do not send an e-Transfer.";
}

function setAvailable() {
  statusHeading.textContent = "Complete the anti-spam check to continue.";
  statusCopy.textContent =
    "Online ordering is available. Payment instructions appear after a successful order; Mitch confirms each transfer manually.";
  submitNote.textContent =
    "Interac e-Transfer only. Do not send money until you receive your order reference and payment instructions.";
}

function setError(message) {
  error.textContent = message;
}

function formatCurrency(cents) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" })
    .format(cents / 100);
}

function updateRecipientModeFromForm() {
  const isOther = form.querySelector('input[name="recipientType"]:checked')?.value === "other";
  recipientDetails.hidden = !isOther;
  recipientName.required = isOther;
  recipientEmail.required = isOther;
}

for (const radio of form.querySelectorAll('input[name="preset"]')) {
  radio.addEventListener("change", () => {
    customAmount.value = "";
    updateTotal();
  });
}

customAmount.addEventListener("input", () => {
  form.querySelectorAll('input[name="preset"]').forEach((radio) => {
    radio.checked = false;
  });
  updateTotal();
});

form.querySelectorAll('input[name="recipientType"]').forEach((radio) => {
  radio.addEventListener("change", updateRecipientModeFromForm);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitOrder();
});

document.querySelector("#payment-reported").addEventListener("click", () => {
  void reportPayment();
});
document.querySelector("#copy-reference").addEventListener("click", (event) =>
  copyText(activeOrder?.orderRef, event.currentTarget));
document.querySelector("#copy-email").addEventListener("click", (event) =>
  copyText(activeOrder?.interacEmail, event.currentTarget));

updateRecipientMode();
updateTotal();
void initialize();

async function initialize() {
  if (window.location.origin !== PRODUCTION_SITE_ORIGIN) {
    setUnavailable(
      "Production ordering is unavailable in this local preview.",
      "This page does not contact the production Worker from local or staging origins. No details will be sent or stored. Do not send money."
    );
    return;
  }

  let productionConfig;
  try {
    productionConfig = validateProductionAdminConfig(config);
  } catch {
    setUnavailable(
      "Production checkout is not configured.",
      "The production configuration could not be verified. No order has been submitted."
    );
    return;
  }
  workerApiBaseUrl = productionConfig.workerApiBaseUrl;

  activeOrder = loadActiveOrder();
  if (activeOrder) {
    showOrderResult();
    return;
  }

  try {
    const response = await fetch(`${workerApiBaseUrl}/api/healthz`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const health = await readJson(response);
    if (!response.ok || health.environment !== "production") {
      throw new Error("The production checkout could not be verified.");
    }
    if (health.orderingEnabled !== true) {
      setUnavailable(
        "Online ordering is temporarily disabled.",
        "No order can be created right now. No payment is due. Do not send money."
      );
      return;
    }
    if (typeof config.turnstileSiteKey !== "string" || !config.turnstileSiteKey) {
      setUnavailable(
        "Production anti-spam verification is not configured.",
        "Ordering remains unavailable until the production Turnstile site key is configured."
      );
      return;
    }

    orderingEnabled = true;
    setAvailable();
    await initializeTurnstile(config.turnstileSiteKey);
  } catch {
    setUnavailable(
      "Production checkout could not be verified.",
      "The production API or anti-spam check is unavailable. No order has been submitted. Please try again later."
    );
  }
}

async function initializeTurnstile(siteKey) {
  await loadTurnstileScript();
  turnstileTarget.hidden = false;
  turnstileWidget = window.turnstile.render(turnstileTarget, {
    sitekey: siteKey,
    action: "gift_card_order",
    callback: (token) => {
      turnstileToken = token;
      submitButton.disabled = !orderingEnabled;
      submitButton.textContent = "Place e-Transfer order";
      setError("");
    },
    "expired-callback": () => {
      turnstileToken = "";
      submitButton.disabled = true;
      submitButton.textContent = "Complete verification to continue";
    },
    "error-callback": () => {
      turnstileToken = "";
      submitButton.disabled = true;
      submitButton.textContent = "Complete verification to continue";
      setError("The anti-spam check failed. Please try again.");
    }
  });
}

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      if (window.turnstile) resolve();
      else reject(new Error("Turnstile did not initialize."));
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile could not load.")), { once: true });
    document.head.append(script);
  });
}

async function submitOrder() {
  setError("");
  if (submitting || activeOrder) return;
  if (!orderingEnabled) {
    setUnavailable(
      "Online ordering is temporarily disabled.",
      "No order can be created right now. No payment is due. Do not send money."
    );
    return;
  }
  if (!turnstileToken) {
    setError("Complete the anti-spam check before submitting.");
    return;
  }
  if (!form.reportValidity()) return;

  const amountCents = selectedAmount();
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
    setError("Enter a valid amount greater than zero.");
    return;
  }
  const isOther = form.querySelector('input[name="recipientType"]:checked')?.value === "other";
  const purchaserName = document.querySelector("#buyer-name").value.trim();
  const purchaserEmail = document.querySelector("#buyer-email").value.trim();
  const data = {
    amountCents,
    purchaserName,
    purchaserEmail,
    recipientName: isOther ? recipientName.value.trim() : purchaserName,
    recipientEmail: isOther ? recipientEmail.value.trim() : purchaserEmail,
    recipientType: isOther ? "other" : "self",
    message: document.querySelector("#gift-message").value.trim()
  };

  submitting = true;
  submitButton.disabled = true;
  submitButton.textContent = "Submitting order...";
  try {
    const accessToken = getOrCreateSessionValue(orderTokenKey, randomToken);
    const idempotencyKey = getOrCreateSessionValue(orderRequestKey, () => crypto.randomUUID());
    const response = await fetch(`${workerApiBaseUrl}/api/orders`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      cache: "no-store",
      body: JSON.stringify({ ...data, accessToken, idempotencyKey, turnstileToken })
    });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error || "The order could not be created.");
    if (result.testOnly !== false ||
        typeof result.orderRef !== "string" ||
        !/^MHT-PROD-[0-9A-F]{16}$/.test(result.orderRef) ||
        typeof result.accessToken !== "string" ||
        !result.accessToken ||
        !Number.isSafeInteger(result.amountCents) ||
        result.amountCents < 1 ||
        typeof result.purchaserEmail !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.purchaserEmail) ||
        typeof result.emailSent !== "boolean" ||
        !["pending_payment", "payment_reported", "paid"].includes(result.paymentStatus) ||
        typeof result.interacEmail !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.interacEmail)) {
      throw new Error("The production Worker returned an invalid order confirmation.");
    }

    activeOrder = {
      orderRef: result.orderRef,
      accessToken: result.accessToken,
      amountCents: result.amountCents,
      purchaserEmail: result.purchaserEmail,
      interacEmail: result.interacEmail,
      emailSent: result.emailSent,
      paymentStatus: result.paymentStatus,
      testOnly: false
    };
    try {
      sessionStorage.setItem(activeOrderKey, JSON.stringify(activeOrder));
      sessionStorage.removeItem(orderTokenKey);
      sessionStorage.removeItem(orderRequestKey);
    } catch {
      setError("Order created. Keep this page open to retain your payment instructions.");
    }
    showOrderResult();
  } catch (requestError) {
    setError(requestError instanceof Error
      ? requestError.message
      : "The order could not be created. Please try again.");
  } finally {
    submitting = false;
    turnstileToken = "";
    if (turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
    if (!activeOrder) {
      submitButton.disabled = true;
      submitButton.textContent = "Complete verification to continue";
    }
  }
}

async function reportPayment() {
  if (!activeOrder || activeOrder.paymentStatus !== "pending_payment" ||
      window.location.origin !== PRODUCTION_SITE_ORIGIN) {
    return;
  }
  const button = document.querySelector("#payment-reported");
  const reportStatus = document.querySelector("#report-status");
  button.disabled = true;
  reportStatus.textContent = "Sending payment report...";
  try {
    const response = await fetch(
      `${workerApiBaseUrl}/api/orders/${encodeURIComponent(activeOrder.orderRef)}/report-payment`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${activeOrder.accessToken}`
        },
        cache: "no-store"
      }
    );
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error || "The payment report could not be sent.");
    if (result.certificateIssued === true ||
        !["payment_reported", "paid"].includes(result.paymentStatus)) {
      throw new Error("The payment report response could not be verified.");
    }
    activeOrder.paymentStatus = result.paymentStatus;
    try {
      sessionStorage.setItem(activeOrderKey, JSON.stringify(activeOrder));
    } catch {
      // The current page still retains the verified order state in memory.
    }
    showOrderResult();
  } catch (requestError) {
    reportStatus.textContent = requestError instanceof Error
      ? requestError.message
      : "The payment report could not be sent. Please try again.";
    button.disabled = false;
  }
}

function showOrderResult() {
  form.hidden = true;
  orderResult.hidden = false;
  statusHeading.textContent = activeOrder.paymentStatus === "paid"
    ? "Payment confirmed by Mitch."
    : "Order received. Payment is not yet confirmed.";
  statusCopy.textContent = activeOrder.paymentStatus === "paid"
    ? "The certificate is issued only after payment confirmation and is delivered by email."
    : "Use the instructions below. Mitch must verify the transfer before a certificate is issued.";
  document.querySelector("#order-reference").textContent = activeOrder.orderRef;
  document.querySelector("#transfer-amount").textContent = `${formatCurrency(activeOrder.amountCents)} CAD`;
  document.querySelector("#transfer-email").textContent = activeOrder.interacEmail;
  document.querySelector("#result-copy").textContent = activeOrder.paymentStatus === "paid"
    ? "Payment has been confirmed. No additional transfer is due."
    : `Send exactly ${formatCurrency(activeOrder.amountCents)} CAD to ${activeOrder.interacEmail} and include ${activeOrder.orderRef} in the e-Transfer message.`;
  document.querySelector("#email-status").textContent = activeOrder.emailSent
    ? `Payment instructions were emailed to ${activeOrder.purchaserEmail}.`
    : "The order was created, but the confirmation email could not be sent. Use the instructions shown here and contact Mitch if needed.";

  const paymentReported = document.querySelector("#payment-reported");
  const reportStatus = document.querySelector("#report-status");
  if (activeOrder.paymentStatus === "payment_reported") {
    paymentReported.hidden = true;
    reportStatus.textContent =
      "Your transfer report was received. This does not confirm payment or activate the certificate.";
  } else if (activeOrder.paymentStatus === "paid") {
    paymentReported.hidden = true;
    reportStatus.textContent =
      "Mitch has confirmed payment. Certificate delivery is handled by email.";
  } else {
    paymentReported.hidden = false;
    paymentReported.disabled = false;
    reportStatus.textContent = "";
  }
}

function loadActiveOrder() {
  try {
    const order = JSON.parse(sessionStorage.getItem(activeOrderKey) || "null");
    if (order?.testOnly === false &&
        typeof order.orderRef === "string" &&
        /^MHT-PROD-[0-9A-F]{16}$/.test(order.orderRef) &&
        typeof order.accessToken === "string" &&
        Number.isSafeInteger(order.amountCents) &&
        typeof order.interacEmail === "string") {
      return order;
    }
  } catch {
    return null;
  }
  return null;
}

function getOrCreateSessionValue(key, create) {
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const value = create();
    sessionStorage.setItem(key, value);
    return value;
  } catch {
    throw new Error("Secure order retry storage is unavailable. No order was submitted.");
  }
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("The production Worker returned an invalid response.");
  }
}

async function copyText(value, button) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    const original = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = original; }, 1500);
  } catch {
    button.textContent = "Copy unavailable";
  }
}
