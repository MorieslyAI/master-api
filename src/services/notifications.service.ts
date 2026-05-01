import { getDb } from "../lib/firebase.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const COL_USERS = "users";
const SUB_NOTIFS = "notifications";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotifType = "critical" | "warning" | "info" | "success";
export type NotifCategory =
  | "sugar"
  | "protein"
  | "hydration"
  | "calories"
  | "streak"
  | "medical"
  | "scan"
  | "system";

export interface StoredNotification {
  id: string;
  type: NotifType;
  category: NotifCategory;
  title: string;
  message: string;
  timestamp: string; // ISO 8601
  read: boolean;
}

export interface NotificationsListResult {
  notifications: StoredNotification[];
  unreadCount: number;
}

// ─── Keyword lists ────────────────────────────────────────────────────────────

const ALCOHOL_KEYWORDS = [
  "beer", "wine", "alcohol", "vodka", "whiskey", "whisky",
  "rum", "gin", "sake", "cocktail", "brandy", "bourbon",
];
const CAFFEINE_KEYWORDS = [
  "coffee", "espresso", "latte", "cappuccino", "americano",
  "energy drink", "red bull", "monster", "matcha", "tea",
];
const HEALTHY_KEYWORDS = [
  "salad", "broccoli", "spinach", "kale", "avocado", "quinoa",
  "tofu", "tempeh", "edamame", "cucumber", "celery",
];

// ─── Notifications Service ────────────────────────────────────────────────────

export const notificationsService = {

  // ── Upsert (create or overwrite) a notification ────────────────────────────
  async upsert(userId: string, notif: StoredNotification): Promise<void> {
    const db = getDb();
    await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_NOTIFS)
      .doc(notif.id)
      .set(notif);
  },

  // ── Get recent notifications (newest first) ────────────────────────────────
  async getAll(
    userId: string,
    limit = 30,
  ): Promise<NotificationsListResult> {
    const db = getDb();
    // Firestore auto-indexes single-field orderBy — no manual index needed.
    const snap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_NOTIFS)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    const notifications: StoredNotification[] = snap.docs.map(
      (d) => ({ ...d.data() } as StoredNotification),
    );
    const unreadCount = notifications.filter((n) => !n.read).length;
    return { notifications, unreadCount };
  },

  // ── Get unread count only (cheap badge refresh) ────────────────────────────
  async getUnreadCount(userId: string): Promise<number> {
    const db = getDb();
    const snap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_NOTIFS)
      .where("read", "==", false)
      .get();
    return snap.size;
  },

  // ── Mark all notifications as read ─────────────────────────────────────────
  async markAllRead(userId: string): Promise<void> {
    const db = getDb();
    const snap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_NOTIFS)
      .where("read", "==", false)
      .get();

    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.update(d.ref, { read: true }));
    await batch.commit();
  },

  // ── Delete a single notification ───────────────────────────────────────────
  async deleteOne(userId: string, notifId: string): Promise<void> {
    const db = getDb();
    await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_NOTIFS)
      .doc(notifId)
      .delete();
  },

  // ── Generate and persist notifications from a saved history item ───────────
  //
  // Called after every POST /dashboard/history save.
  // Fires-and-forgets from the route; errors are swallowed so they never block
  // the main save response.
  async generateFromHistoryItem(userId: string, item: any): Promise<void> {
    const action = item.action as string | undefined;
    if (action !== "consumed" && action !== "rejected") return;

    const now  = new Date().toISOString();
    const name = String(item.name || "").toLowerCase();
    const sugar    = Number(item.sugarg)           || 0;
    const calories = Number(item.calories)         || 0;
    const protein  = Number(item.macros?.protein)  || 0;
    const gi       = Number(item.glycemicIndex)    || 0;
    const dateStr  = item.date || new Date().toISOString().split("T")[0];

    const notifs: StoredNotification[] = [];

    // ── REJECTION — positive reinforcement ───────────────────────────────────
    if (action === "rejected" && sugar > 10) {
      notifs.push({
        id: `rejected-${item.id}`,
        type: "success",
        category: "sugar",
        title: "SUGAR DENIED",
        message: `You refused ${item.name}. ${sugar.toFixed(0)}g of sugar neutralized. Protocol integrity preserved.`,
        timestamp: now,
        read: false,
      });
    }

    // ── CONSUMED items ────────────────────────────────────────────────────────
    if (action === "consumed") {

      // Sugar spike detection
      if (sugar > 25 || (sugar > 15 && gi > 55)) {
        notifs.push({
          id: `sugar-spike-${item.id}`,
          type: "critical",
          category: "sugar",
          title: "SUGAR SPIKE DETECTED",
          message: `${item.name} — ${sugar.toFixed(0)}g sugar${gi > 55 ? `, GI ${gi}` : ""}. Insulin response imminent. Consider a 10-min walk.`,
          timestamp: now,
          read: false,
        });
      } else if (sugar > 15) {
        notifs.push({
          id: `sugar-warn-${item.id}`,
          type: "warning",
          category: "sugar",
          title: "ELEVATED SUGAR LOAD",
          message: `${item.name} added ${sugar.toFixed(0)}g of sugar. Monitor your daily running total.`,
          timestamp: now,
          read: false,
        });
      }

      // High calorie load
      if (calories > 600) {
        notifs.push({
          id: `calorie-bomb-${item.id}`,
          type: "warning",
          category: "calories",
          title: "HIGH CALORIC LOAD",
          message: `${item.name} — ${calories} kcal logged. Consider balancing your next meal to stay within target.`,
          timestamp: now,
          read: false,
        });
      }

      // Protein achievement
      if (protein >= 20) {
        notifs.push({
          id: `protein-boost-${item.id}`,
          type: "success",
          category: "protein",
          title: "PROTEIN INTAKE LOGGED",
          message: `${item.name} delivered ${protein.toFixed(0)}g of protein. Muscle synthesis window is active.`,
          timestamp: now,
          read: false,
        });
      }

      // Alcohol detection
      if (ALCOHOL_KEYWORDS.some((kw) => name.includes(kw))) {
        notifs.push({
          id: `alcohol-${item.id}`,
          type: "warning",
          category: "sugar",
          title: "LIVER TOXICITY ALERT",
          message: `Alcohol detected: ${item.name}. Hepatic processing underway. Hydrate with 500ml water immediately.`,
          timestamp: now,
          read: false,
        });
      }

      // Caffeine detection
      if (CAFFEINE_KEYWORDS.some((kw) => name.includes(kw))) {
        notifs.push({
          id: `caffeine-${item.id}`,
          type: "info",
          category: "hydration",
          title: "ADRENAL STIMULANT",
          message: `Caffeine from ${item.name} detected. Cortisol may spike. Pair with water to prevent dehydration.`,
          timestamp: now,
          read: false,
        });
      }

      // Healthy food recognition
      if (HEALTHY_KEYWORDS.some((kw) => name.includes(kw))) {
        notifs.push({
          id: `healthy-${item.id}`,
          type: "success",
          category: "protein",
          title: "NUTRIENT PROTOCOL ACTIVE",
          message: `${item.name} — high micronutrient density logged. Cellular optimization cycle initiated.`,
          timestamp: now,
          read: false,
        });
      }
    }

    // ── Daily sugar limit check (upsert by stable date-scoped ID) ────────────
    await this._checkAndUpsertDailyLimitAlert(userId, dateStr, now);

    // ── Persist all generated notifications ──────────────────────────────────
    await Promise.all(notifs.map((n) => this.upsert(userId, n)));
  },

  // ── Internal: upsert limit-breach / threshold-warning for the day ──────────
  async _checkAndUpsertDailyLimitAlert(
    userId: string,
    dateStr: string,
    now: string,
  ): Promise<void> {
    const db = getDb();

    // Read user profile for the sugar limit
    const userDoc = await db.collection(COL_USERS).doc(userId).get();
    if (!userDoc.exists) return;
    const profile = userDoc.data()?.profile;
    const limit: number | undefined = profile?.sugarLimit;
    if (!limit) return;

    // Sum today's consumed sugar
    const logsSnap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection("logs")
      .where("date", "==", dateStr)
      .get();

    let totalSugar = 0;
    logsSnap.docs.forEach((d) => {
      const log = d.data();
      if (log.action === "consumed") {
        totalSugar += Number(log.sugarg) || 0;
      }
    });

    const breachId = `sugar-daily-breach-${dateStr}`;
    const warnId   = `sugar-daily-warn-${dateStr}`;

    if (totalSugar > limit) {
      await this.upsert(userId, {
        id: breachId,
        type: "critical",
        category: "sugar",
        title: "PROTOCOL BREACH",
        message: `Daily sugar limit exceeded by ${(totalSugar - limit).toFixed(0)}g (${totalSugar.toFixed(0)}g / ${limit}g). Immediate dietary cessation recommended.`,
        timestamp: now,
        read: false,
      });
      // Delete the warning so only one card is shown
      await db
        .collection(COL_USERS)
        .doc(userId)
        .collection(SUB_NOTIFS)
        .doc(warnId)
        .delete()
        .catch(() => {});
    } else if (totalSugar > limit * 0.8) {
      await this.upsert(userId, {
        id: warnId,
        type: "warning",
        category: "sugar",
        title: "THRESHOLD APPROACHING",
        message: `Daily sugar at ${((totalSugar / limit) * 100).toFixed(0)}% of limit (${totalSugar.toFixed(0)}g / ${limit}g). Tread carefully.`,
        timestamp: now,
        read: false,
      });
    }
  },
};
