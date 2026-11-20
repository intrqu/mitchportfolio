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
const result = document.querySelector("#order-result");
const submitButton = document.querySelector("#submit-order");
const pendingOrderTokenKey = "mhtGiftCardPendingOrderToken";
const pendingOrderIdKey = "mhtGiftCardPendingOrderId";
let activeOrder = null;
let turnstileWidget = null;
let turnstileToken = "";

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

if (config?.apiKey?.startsWith("REPLACE_") ||
    !config?.workerApiBaseUrl ||
    !config?.turnstileSiteKey) {
  error.textContent = "Staging checkout is not configured yet. No order has been submitted.";
  submitButton.disabled = true;
} else {
  try {
    activeOrder = JSON.parse(sessionStorage.getItem("mhtGiftCardOrder") || "null");
    if (activeOrder?.orderRef && activeOrder?.accessToken && activeOrder?.amountCents &&
        activeOrder?.testOnly === true) {
      showOrderResult(activeOrder);
      form.hidden = true;
    } else {
      activeOrder = null;
    }
  } catch {
    activeOrder = null;
  }

  initializeTurnstile();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const cents = selectedAmount();
    if (!Number.isSafeInteger(cents) || cents < 1) {
      error.textContent = "Enter a valid amount greater than zero.";
      return;
    }
    if (!turnstileToken) {
      error.textContent = "Complete the anti-spam check before submitting.";
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
    submitButton.textContent = "Creating test order…";
    try {
      const accessToken = getOrCreateSessionValue(pendingOrderTokenKey, () => randomToken());
      const idempotencyKey = getOrCreateSessionValue(pendingOrderIdKey, () => crypto.randomUUID());
      const response = await fetch(`${config.workerApiBaseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          accessToken,
          idempotencyKey,
          turnstileToken
        })
      });
      const responseBody = await response.json();
      if (!response.ok) throw apiError(responseBody);
      if (responseBody.testOnly !== true) {
        throw new Error("The staging API did not confirm test-only mode. No order result was accepted.");
      }

      sessionStorage.removeItem(pendingOrderTokenKey);
      sessionStorage.removeItem(pendingOrderIdKey);
      activeOrder = {
        orderRef: responseBody.orderRef,
        accessToken: responseBody.accessToken,
        amountCents: responseBody.amountCents,
        purchaserEmail: responseBody.purchaserEmail,
        emailSent: responseBody.emailSent,
        testOnly: true,
        reusedRequest: responseBody.reusedRequest
      };
      sessionStorage.setItem("mhtGiftCardOrder", JSON.stringify(activeOrder));
      showOrderResult(activeOrder);
      form.hidden = true;
    } catch (requestError) {
      error.textContent = requestError.message || "We couldn't create your test order. Please try again.";
      submitButton.disabled = false;
      submitButton.textContent = "Create test order";
    } finally {
      turnstileToken = "";
      if (turnstileWidget !== null) window.turnstile?.reset(turnstileWidget);
    }
  });

  const copyReferenceButton = document.querySelector("#copy-reference");
  if (copyReferenceButton) {
    copyReferenceButton.addEventListener("click", () =>
      copyText(activeOrder?.orderRef, copyReferenceButton));
  }
  const downloadButton = document.querySelector("#download-certificate");
  downloadButton.addEventListener("click", downloadCertificate);

  async function downloadCertificate() {
    if (!activeOrder) return;
    error.textContent = "";
    downloadButton.disabled = true;
    try {
      const response = await fetch(
        `${config.workerApiBaseUrl}/api/orders/${encodeURIComponent(activeOrder.orderRef)}/certificate.pdf`,
        { headers: { Authorization: `Bearer ${activeOrder.accessToken}` } }
      );
      if (!response.ok) {
        const body = await response.json();
        throw apiError(body);
      }
      const pdf = await response.blob();
      const link = document.createElement("a");
      const objectUrl = URL.createObjectURL(pdf);
      link.href = objectUrl;
      link.download = `${activeOrder.orderRef}-VOID-TEST-ONLY.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch (requestError) {
      error.textContent = requestError.message || "The certificate is not available yet.";
    } finally {
      downloadButton.disabled = false;
    }
  }

  function initializeTurnstile() {
    const target = document.querySelector("#order-turnstile");
    const render = () => {
      if (!target || !window.turnstile) {
        error.textContent = "The staging anti-spam check did not load. Refresh the page to try again.";
        submitButton.disabled = true;
        return;
      }
      turnstileWidget = window.turnstile.render(target, {
        sitekey: config.turnstileSiteKey,
        action: "gift_card_order",
        callback: (token) => {
          turnstileToken = token;
          error.textContent = "";
        },
        "expired-callback": () => { turnstileToken = ""; },
        "error-callback": () => {
          turnstileToken = "";
          error.textContent = "The anti-spam check failed to load. Please refresh the page.";
        }
      });
    };
    if (window.turnstile) {
      render();
      return;
    }
    const script = document.querySelector("#turnstile-api");
    if (!script) {
      error.textContent = "The staging anti-spam check is unavailable. Please refresh the page.";
      submitButton.disabled = true;
      return;
    }
    script.addEventListener("load", render, { once: true });
    script.addEventListener("error", () => {
      error.textContent = "The staging anti-spam check could not be loaded. Please refresh the page.";
      submitButton.disabled = true;
    }, { once: true });
    setTimeout(() => {
      if (!window.turnstile && !turnstileWidget) {
        error.textContent = "The staging anti-spam check is taking too long. Refresh the page to try again.";
        submitButton.disabled = true;
      }
    }, 10_000);
  }

  function showOrderResult(order) {
    document.querySelector("#order-reference").textContent = order.orderRef;
    document.querySelector("#transfer-amount").textContent = new Intl.NumberFormat("en-CA", {
      style: "currency", currency: "CAD"
    }).format(order.amountCents / 100) + " CAD";
    result.querySelector(".kicker").textContent = "VOID — TEST ONLY";
    result.querySelector("h2").textContent = "Test order created.";
    document.querySelector("#result-copy").textContent =
      `${order.reusedRequest ? "We recovered your existing test order. " : ""}This order is stored only in the isolated staging database. No payment is due or accepted. Any certificate issued during testing will be void and have no monetary value.`;
    document.querySelector("#email-status").textContent = order.emailSent
      ? `A test-only confirmation was sent to ${order.purchaserEmail}.`
      : "The order was saved, but the test email could not be sent. Check the staging email configuration.";
    document.querySelector("#download-certificate").hidden = false;
    document.querySelector("#payment-reported").hidden = true;
    document.querySelector("#report-status").hidden = true;
    result.hidden = false;
  }
}

function getOrCreateSessionValue(key, create) {
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const value = create();
  sessionStorage.setItem(key, value);
  return value;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function apiError(body) {
  const error = new Error(body?.error || "The request could not be completed.");
  error.code = `functions/${body?.code || "internal"}`;
  return error;
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
