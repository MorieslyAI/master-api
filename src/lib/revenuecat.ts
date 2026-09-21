import { env } from "../config/env.js";

const REVENUECAT_API_BASE = "https://api.revenuecat.com/v1";

export interface RevenueCatEntitlementInfo {
  expires_date: string | null;
  product_identifier: string;
  purchase_date: string;
}

export interface RevenueCatSubscriber {
  entitlements: Record<string, RevenueCatEntitlementInfo>;
}

interface RevenueCatSubscriberResponse {
  subscriber: RevenueCatSubscriber;
}

/**
 * Fetches the authoritative, current subscriber state from RevenueCat's REST API.
 * We re-fetch instead of trusting the webhook payload alone because webhook events
 * only describe the single change that triggered them (e.g. one entitlement),
 * while this returns the full, current set of active entitlements.
 */
export async function fetchRevenueCatSubscriber(
  appUserId: string,
): Promise<RevenueCatSubscriber> {
  if (!env.REVENUECAT_SECRET_API_KEY) {
    throw new Error(
      "[revenuecat] REVENUECAT_SECRET_API_KEY belum dikonfigurasi.",
    );
  }

  const res = await fetch(
    `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(appUserId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.REVENUECAT_SECRET_API_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[revenuecat] Gagal mengambil data subscriber "${appUserId}" (status ${res.status}): ${body}`,
    );
  }

  const data = (await res.json()) as RevenueCatSubscriberResponse;
  return data.subscriber;
}
