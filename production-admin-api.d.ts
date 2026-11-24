export interface ProductionAdminConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  workerApiBaseUrl: string;
}

export interface ProductionAdminApi {
  call(
    action: "listOrders" | "sales" | "archiveOrder" | "restoreOrder" |
      "confirmPayment" | "retryOrderEmails" |
      "resendCertificate" | "lookupCertificate" | "redeemCertificate",
    data?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export function validateProductionAdminConfig(
  config: ProductionAdminConfig
): { workerApiBaseUrl: string };

export function createProductionAdminApi(
  config: ProductionAdminConfig,
  auth: { currentUser: { getIdToken(): Promise<string> } | null },
  fetcher?: typeof fetch
): ProductionAdminApi;
