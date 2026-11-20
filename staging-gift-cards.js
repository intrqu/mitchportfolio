const form = document.querySelector("#gift-order");
const customAmount = document.querySelector("#custom-amount");
const total = document.querySelector("#total");
const recipientDetails = document.querySelector("#recipient-details");
const recipientName = document.querySelector("#recipient-name");
const recipientEmail = document.querySelector("#recipient-email");
const giftMessage = document.querySelector("#gift-message");
const amountRadios = [...document.querySelectorAll('input[name="preset"]')];
const result = document.querySelector("#order-result");

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
form.querySelectorAll('input[name="recipientType"]')
  .forEach((input) => input.addEventListener("change", setRecipientMode));
setRecipientMode();
updateTotal();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const amountCents = selectedAmount();
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
    document.querySelector("#order-error").textContent = "Enter a valid amount greater than zero.";
    return;
  }

  const isOther = form.querySelector('input[name="recipientType"]:checked').value === "other";
  const recipient = isOther ? recipientName.value.trim() : form.elements.buyerName.value.trim();
  const message = giftMessage.value.trim();
  const reference = `TEST-ONLY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const formattedAmount = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" })
    .format(amountCents / 100);

  form.hidden = true;
  result.querySelector(".kicker").textContent = "Local test preview";
  result.querySelector("h2").textContent = "Test preview only.";
  document.querySelector("#result-copy").textContent =
    `Local demo order ${reference}. No payment is collected, no email is sent, and no data leaves this browser.`;
  document.querySelector(".payment-details")?.remove();
  document.querySelector("#email-status").textContent = "Email delivery is disabled on this test site.";
  document.querySelector("#payment-reported").hidden = true;
  document.querySelector("#report-status").textContent = "";

  const previewButton = document.createElement("button");
  previewButton.type = "button";
  previewButton.className = "solid";
  previewButton.textContent = "Preview VOID test certificate";
  previewButton.addEventListener("click", () => {
    showTestCertificate({ amount: formattedAmount, recipient, message });
    previewButton.disabled = true;
    previewButton.textContent = "VOID test preview shown";
  });
  result.append(previewButton);
  result.hidden = false;
});

function showTestCertificate(certificate) {
  const preview = document.createElement("article");
  preview.className = "staging-certificate";
  const brand = document.createElement("p");
  brand.className = "kicker";
  brand.textContent = "Mitch Harsch Tattoo";
  const heading = document.createElement("h3");
  heading.textContent = "Gift Certificate Preview";
  const status = document.createElement("p");
  status.className = "staging-void";
  status.textContent = "VOID — TEST ONLY";
  const value = document.createElement("p");
  value.textContent = certificate.amount;
  const recipient = document.createElement("p");
  recipient.textContent = `For ${certificate.recipient}`;
  const note = document.createElement("p");
  note.className = "staging-demo-notice";
  note.textContent = "Preview only: no redemption code exists and this certificate cannot be redeemed.";
  preview.append(brand, heading, status, value, recipient);
  if (certificate.message) {
    const message = document.createElement("p");
    message.textContent = certificate.message;
    preview.append(message);
  }
  preview.append(note);
  result.append(preview);
}
