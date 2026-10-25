import { Timestamp } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";

const COL_USERS = "users";
const COL_REQUESTS = "accountDeletionRequests";
const COL_ADMIN_ACTIVITY = "adminActivityLogs";
const REQUEST_DEADLINE_DAYS = 7;

export type AccountDeletionStatus =
  | "pending"
  | "processing"
  | "completed"
  | "rejected";

export interface CreateAccountDeletionRequestDTO {
  reason?: string;
  source?: string;
}

export interface AccountDeletionFilters {
  search?: string;
  status?: AccountDeletionStatus;
}

export interface UpdateAccountDeletionStatusDTO {
  status: Exclude<AccountDeletionStatus, "pending">;
  adminNote?: string | null;
}

function httpError(message: string, statusCode: number): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate().toISOString();
  }
  return null;
}

function serializeRequest(id: string, data: Record<string, unknown>) {
  return {
    id,
    userId: data["userId"] ?? null,
    displayName: data["displayName"] ?? null,
    email: data["email"] ?? null,
    userCreatedAt: toIsoString(data["userCreatedAt"]),
    requestedAt: toIsoString(data["requestedAt"]),
    deadlineAt: toIsoString(data["deadlineAt"]),
    reason: data["reason"] ?? null,
    source: data["source"] ?? "Aplikasi",
    status: data["status"] ?? "pending",
    dataScopes: Array.isArray(data["dataScopes"]) ? data["dataScopes"] : [],
    adminNote: data["adminNote"] ?? null,
    processedAt: toIsoString(data["processedAt"]),
    resolvedAt: toIsoString(data["resolvedAt"]),
    processedBy: data["processedBy"] ?? null,
  };
}

function isActiveStatus(status: unknown): boolean {
  return status === "pending" || status === "processing";
}

function assertTransition(
  currentStatus: AccountDeletionStatus,
  nextStatus: UpdateAccountDeletionStatusDTO["status"],
): void {
  const allowed: Record<AccountDeletionStatus, AccountDeletionStatus[]> = {
    pending: ["processing", "rejected"],
    processing: ["completed"],
    completed: [],
    rejected: [],
  };

  if (!allowed[currentStatus]?.includes(nextStatus)) {
    throw httpError(
      `Status tidak dapat diubah dari ${currentStatus} menjadi ${nextStatus}.`,
      409,
    );
  }
}

export const accountDeletionService = {
  async createForUser(
    userId: string,
    dto: CreateAccountDeletionRequestDTO,
  ) {
    const db = getDb();
    const userRef = db.collection(COL_USERS).doc(userId);
    const requestRef = db.collection(COL_REQUESTS).doc();

    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw httpError("User tidak ditemukan.", 404);

      const user = userDoc.data() as Record<string, unknown>;
      const profile =
        typeof user["profile"] === "object" && user["profile"] !== null
          ? (user["profile"] as Record<string, unknown>)
          : {};
      const activeRequestId = user["accountDeletionRequestId"];

      if (typeof activeRequestId === "string" && activeRequestId) {
        const existing = await transaction.get(
          db.collection(COL_REQUESTS).doc(activeRequestId),
        );
        if (existing.exists && isActiveStatus(existing.data()?.["status"])) {
          throw httpError(
            "Permintaan penghapusan akun masih menunggu atau sedang diproses.",
            409,
          );
        }
      }

      const now = Timestamp.now();
      const deadlineAt = Timestamp.fromMillis(
        now.toMillis() + REQUEST_DEADLINE_DAYS * 24 * 60 * 60 * 1000,
      );

      transaction.set(requestRef, {
        userId,
        displayName: user["displayName"] ?? profile["name"] ?? null,
        email: user["email"] ?? null,
        userCreatedAt: user["createdAt"] ?? null,
        requestedAt: now,
        deadlineAt,
        reason: dto.reason?.trim() || null,
        source: dto.source?.trim() || "Aplikasi",
        status: "pending" satisfies AccountDeletionStatus,
        dataScopes: [
          "Profil dan preferensi",
          "Riwayat aktivitas",
          "File pengguna",
          "Data langganan",
        ],
        adminNote: null,
        processedAt: null,
        resolvedAt: null,
        processedBy: null,
        updatedAt: now,
      });

      transaction.update(userRef, {
        accountDeletionRequestId: requestRef.id,
        accountDeletionStatus: "pending",
        accountDeletionRequestedAt: now,
        updatedAt: now,
      });
    });

    const created = await requestRef.get();
    return serializeRequest(requestRef.id, created.data() ?? {});
  },

  async getForUser(userId: string) {
    const db = getDb();
    const userDoc = await db.collection(COL_USERS).doc(userId).get();
    if (!userDoc.exists) throw httpError("User tidak ditemukan.", 404);

    const requestId = userDoc.data()?.["accountDeletionRequestId"];
    if (typeof requestId !== "string" || !requestId) return null;

    const requestDoc = await db.collection(COL_REQUESTS).doc(requestId).get();
    if (!requestDoc.exists) return null;
    return serializeRequest(requestDoc.id, requestDoc.data() ?? {});
  },

  async listForAdmin(filters: AccountDeletionFilters) {
    const db = getDb();
    const snapshot = await db
      .collection(COL_REQUESTS)
      .orderBy("requestedAt", "desc")
      .limit(1000)
      .get();

    const allItems = snapshot.docs.map((doc) =>
      serializeRequest(doc.id, doc.data()),
    );
    const search = filters.search?.trim().toLocaleLowerCase("id-ID") ?? "";
    const items = allItems.filter((item) => {
      if (filters.status && item.status !== filters.status) return false;
      if (!search) return true;
      return [item.displayName, item.email, item.reason, item.id].some((value) =>
        String(value ?? "")
          .toLocaleLowerCase("id-ID")
          .includes(search),
      );
    });

    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const urgentLimit = now.getTime() + 2 * 24 * 60 * 60 * 1000;
    const summary = {
      pending: allItems.filter((item) => item.status === "pending").length,
      processing: allItems.filter((item) => item.status === "processing").length,
      urgent: allItems.filter((item) => {
        const deadline = item.deadlineAt ? new Date(item.deadlineAt).getTime() : 0;
        return item.status === "pending" && deadline > 0 && deadline <= urgentLimit;
      }).length,
      completedThisMonth: allItems.filter((item) => {
        const resolvedAt = item.resolvedAt ? new Date(item.resolvedAt).getTime() : 0;
        return item.status === "completed" && resolvedAt >= monthStart;
      }).length,
    };

    return { items, summary };
  },

  async updateStatus(
    requestId: string,
    adminId: string,
    dto: UpdateAccountDeletionStatusDTO,
  ) {
    const db = getDb();
    const requestRef = db.collection(COL_REQUESTS).doc(requestId);
    const activityRef = db.collection(COL_ADMIN_ACTIVITY).doc();

    await db.runTransaction(async (transaction) => {
      const requestDoc = await transaction.get(requestRef);
      if (!requestDoc.exists) {
        throw httpError("Permintaan penghapusan tidak ditemukan.", 404);
      }

      const requestData = requestDoc.data() as Record<string, unknown>;
      const currentStatus = requestData["status"] as AccountDeletionStatus;
      assertTransition(currentStatus, dto.status);

      const now = Timestamp.now();
      const update: Record<string, unknown> = {
        status: dto.status,
        adminNote: dto.adminNote?.trim() || null,
        processedBy: adminId,
        updatedAt: now,
      };
      if (dto.status === "processing") update["processedAt"] = now;
      if (dto.status === "completed" || dto.status === "rejected") {
        update["resolvedAt"] = now;
      }

      transaction.update(requestRef, update);

      const userId = requestData["userId"];
      if (typeof userId === "string" && userId) {
        transaction.update(db.collection(COL_USERS).doc(userId), {
          accountDeletionStatus: dto.status,
          accountDeletionUpdatedAt: now,
          updatedAt: now,
        });
      }

      transaction.set(activityRef, {
        action: "account_deletion_status_updated",
        actorId: adminId,
        targetType: "accountDeletionRequest",
        targetId: requestId,
        userId: requestData["userId"] ?? null,
        previousStatus: currentStatus,
        status: dto.status,
        note: dto.adminNote?.trim() || null,
        createdAt: now,
      });
    });

    const updated = await requestRef.get();
    return serializeRequest(updated.id, updated.data() ?? {});
  },
};
