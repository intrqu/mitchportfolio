const order = {
  orderRef: "TEST-ONLY-0001",
  purchaserName: "Demo Purchaser",
  purchaserEmail: "purchaser@example.invalid",
  recipientName: "Demo Recipient",
  recipientEmail: "recipient@example.invalid",
  amountCents: 10000,
  paymentStatus: "pending_payment",
  certificateStatus: "not_issued"
};
const dashboard = document.querySelector("#admin-dashboard");
const list = document.querySelector("#order-list");
const certificateDetails = document.querySelector("#certificate-details");

document.querySelector("#admin-login").hidden = true;
dashboard.hidden = false;
document.querySelector("#admin-identity").textContent = "Local demo only — no account or backend connected.";
document.querySelector("#admin-signout").hidden = true;
document.querySelector("#load-more-orders").hidden = true;
document.querySelector("#refresh-orders").addEventListener("click", renderOrder);
document.querySelector("#order-filter").addEventListener("change", renderOrder);
renderOrder();

function renderOrder() {
  list.replaceChildren();
  const filter = document.querySelector("#order-filter").value;
  const paid = order.paymentStatus === "paid";
  const statusFilterMatches = filter === "all" ||
    (filter === "pending" && !paid) ||
    (filter === "paid" && paid && order.certificateStatus === "not_issued") ||
    (filter === "issued" && order.certificateStatus === "issued");
  if (!statusFilterMatches) {
    list.textContent = "No demo orders in this view.";
    return;
  }

  const card = document.createElement("article");
  card.className = "order-card";
  const heading = document.createElement("h3");
  heading.textContent = `${order.orderRef} · ${money(order.amountCents)}`;
  const details = document.createElement("p");
  details.textContent = `${order.purchaserName} (${order.purchaserEmail}) · For ${order.recipientName} (${order.recipientEmail})`;
  const status = document.createElement("p");
  status.className = "muted";
  status.textContent = `${order.paymentStatus.replaceAll("_", " ")} · ${order.certificateStatus.replaceAll("_", " ")}`;
  card.append(heading, details, status);
  const actions = document.createElement("div");
  actions.className = "admin-actions";
  if (!paid) {
    actions.append(actionButton("Simulate test payment confirmation", () => {
      order.paymentStatus = "paid";
      renderOrder();
    }));
  } else {
    actions.append(actionButton(
      order.certificateStatus === "issued" ? "Show VOID test preview" : "Issue VOID test preview",
      () => {
        order.certificateStatus = "issued";
        renderTestCertificate();
        renderOrder();
      }
    ));
  }
  card.append(actions);
  list.append(card);
}

function actionButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outline";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderTestCertificate() {
  certificateDetails.replaceChildren();
  certificateDetails.hidden = false;
  const heading = document.createElement("h3");
  heading.textContent = "Mitch Harsch Tattoo · $100.00 CAD";
  const status = document.createElement("p");
  status.className = "staging-void";
  status.textContent = "VOID — TEST ONLY";
  const note = document.createElement("p");
  note.className = "staging-demo-notice";
  note.textContent = "Demo preview only. No redemption code exists. Lookup and redemption are disabled.";
  const certificate = document.createElement("article");
  certificate.className = "staging-certificate";
  certificate.append(heading, status, note);
  certificateDetails.append(certificate);
}

function money(cents) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" })
    .format(cents / 100) + " CAD";
}
