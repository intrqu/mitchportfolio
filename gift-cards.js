import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const config = window.MHT_FIREBASE_CONFIG;
const form = document.querySelector("#gift-order");
const error = document.querySelector("#order-error");
const customAmount = document.querySelector("#custom-amount");
const total = document.querySelector("#total");
const recipientDetails = document.querySelector("#recipient-details");
const recipientName = document.querySelector("#recipient-name");
const recipientEmail = document.querySelector("#recipient-email");
const giftMessage = document.querySelector("#gift-message");
const amountRadios = [...document.querySelectorAll('input[name="preset"]')];

function selectedAmount() {
  if (customAmount.value !== "") return Math.round(Number(customAmount.value) * 100);
  return Number(form.querySelector('input[name="preset"]:checked')?.value || 0);
}

function updateTotal() {
  const cents = selectedAmount();
  total.textContent = Number.isSafeInteger(cents) && cents > 0
    ? new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100) + " CAD"
    : "Enter an amount";
}

function setRecipientMode() {
  const isOther = form.querySelector('input[name="recipientType"]:checked')?.value === "other";
  recipientDetails.hidden = !isOther;
  recipientName.required = isOther;
  recipientEmail.required = isOther;
}

for (const radio of amountRadios) {
  radio.addEventListener("change", () => {
    customAmount.value = "";
    updateTotal();
  });
}
customAmount.addEventListener("input", () => {
  amountRadios.forEach((radio) => { radio.checked = false; });
  updateTotal();
});
form.querySelectorAll('input[name="recipientType"]').forEach((input) => input.addEventListener("change", setRecipientMode));
setRecipientMode();
updateTotal();

if (config?.apiKey?.startsWith("REPLACE_") || config?.appCheckSiteKey?.startsWith("REPLACE_")) {
  error.textContent = "Gift card checkout is not configured yet. Please contact Mitch through the booking inquiry.";
  form.querySelector("#submit-order").disabled = true;
} else {
  const app = initializeApp(config);
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(config.appCheckSiteKey),
    isTokenAutoRefreshEnabled: true
  });
  const functions = getFunctions(app, "us-west1");
  const createOrder = httpsCallable(functions, "createGiftCardOrder");
  const reportPayment = httpsCallable(functions, "reportInteracPayment");
  const result = document.querySelector("#order-result");
  const submitButton = document.querySelector("#submit-order");
  const pendingOrderTokenKey = "mhtGiftCardPendingOrderToken";
  let activeOrder = null;
  try {
    activeOrder = JSON.parse(sessionStorage.getItem("mhtGiftCardOrder") || "null");
    if (activeOrder?.orderRef && activeOrder?.accessToken && activeOrder?.amountCents && activeOrder?.interacEmail) {
      showOrderResult(activeOrder);
      form.hidden = true;
    } else {
      activeOrder = null;
    }
  } catch {
    activeOrder = null;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const cents = selectedAmount();
    if (!Number.isSafeInteger(cents) || cents < 1) {
      error.textContent = "Enter a valid amount greater than zero.";
      return;
    }

    const isOther = form.querySelector('input[name="recipientType"]:checked').value === "other";
    const data = {
      amountCents: cents,
      purchaserName: form.elements.buyerName.value.trim(),
      purchaserEmail: form.elements.buyerEmail.value.trim(),
      recipientName: isOther ? recipientName.value.trim() : form.elements.buyerName.value.trim(),
      recipientEmail: isOther ? recipientEmail.value.trim() : form.elements.buyerEmail.value.trim(),
      message: giftMessage.value.trim(),
      recipientType: isOther ? "other" : "self"
    };

    submitButton.disabled = true;
    submitButton.textContent = "Placing order…";
    try {
      let accessToken = sessionStorage.getItem(pendingOrderTokenKey);
      if (!/^[A-Za-z0-9_-]{43}$/.test(accessToken || "")) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
        accessToken = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        sessionStorage.setItem(pendingOrderTokenKey, accessToken);
      }
      const response = await createOrder({ ...data, accessToken });
      sessionStorage.removeItem(pendingOrderTokenKey);
      activeOrder = {
        orderRef: response.data.orderRef,
        accessToken: response.data.accessToken,
        amountCents: response.data.amountCents,
        interacEmail: response.data.interacEmail,
        purchaserEmail: response.data.purchaserEmail,
        emailSent: response.data.emailSent,
        reusedRequest: response.data.reusedRequest
      };
      sessionStorage.setItem("mhtGiftCardOrder", JSON.stringify(activeOrder));
      showOrderResult(activeOrder);
      form.hidden = true;
    } catch (requestError) {
      error.textContent = requestError.message || "We couldn't place your order. Please try again.";
      submitButton.disabled = false;
      submitButton.textContent = "Place e-Transfer order";
    }
  });

  document.querySelector("#payment-reported").addEventListener("click", async (event) => {
    if (!activeOrder) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await reportPayment(activeOrder);
      activeOrder.paymentReported = true;
      sessionStorage.setItem("mhtGiftCardOrder", JSON.stringify(activeOrder));
      document.querySelector("#report-status").textContent =
        "Thanks. Mitch has been notified. Your certificate remains inactive until payment is confirmed.";
      button.textContent = "Payment reported";
    } catch (requestError) {
      document.querySelector("#report-status").textContent =
        requestError.message || "We couldn't record your report. Please contact Mitch.";
      button.disabled = false;
    }
  });

  document.querySelector("#copy-reference").addEventListener("click", () =>
    copyText(activeOrder?.orderRef, document.querySelector("#copy-reference")));
  document.querySelector("#copy-email").addEventListener("click", () =>
    copyText(document.querySelector("#transfer-email").textContent, document.querySelector("#copy-email")));

  function showOrderResult(order) {
    document.querySelector("#order-reference").textContent = order.orderRef;
    document.querySelector("#transfer-amount").textContent = new Intl.NumberFormat("en-CA", {
      style: "currency", currency: "CAD"
    }).format(order.amountCents / 100) + " CAD";
    document.querySelector("#transfer-email").textContent = order.interacEmail;
    document.querySelector("#result-copy").textContent = order.emailSent
      ? `${order.reusedRequest ? "We recovered your existing order. " : ""}Payment instructions were sent to ${order.purchaserEmail}. Use the reference below in your e-Transfer message.`
      : "Use the details below to send your e-Transfer and include the order reference in its message.";
    document.querySelector("#email-status").textContent = order.emailSent
      ? ""
      : "We could not send the instruction email. Use the details here and contact Mitch if you need help.";
    if (order.paymentReported) {
      document.querySelector("#payment-reported").disabled = true;
      document.querySelector("#payment-reported").textContent = "Payment reported";
      document.querySelector("#report-status").textContent =
        "Mitch has been notified. Your certificate remains inactive until payment is confirmed.";
    }
    result.hidden = false;
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
