import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getDb } from "../lib/firebase.js";

// ─── Firestore Collections ────────────────────────────────────────────────────
const COL_NEWS = "news_articles";
const COL_POSTS = "social_posts";
const COL_PRODUCTS = "shop_products";
const COL_USERS = "users";
const SUB_PURCHASES = "purchases";
const SUB_SOCIAL = "social_stats";

// ─── Error Helper ─────────────────────────────────────────────────────────────
function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type PostType = "post" | "event" | "video" | "group";

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  source: string;
  imageUrl: string;
  date: string; // ISO 8601
  category: string;
  url?: string;
}

export interface SocialPost {
  id: string;
  type: PostType;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  content: string;
  mediaUrl?: string | null;
  videoThumbnail?: string | null;
  duration?: string | null;
  eventDate?: string | null;
  attendees?: number;
  members?: number;
  groupId?: string | null;
  eventId?: string | null;
  likes: number;
  comments: number;
  createdAt: string; // ISO 8601
}

export interface SocialComment {
  id: string;
  postId: string;
  parentId?: string | null;

  replyToCommentId?: string | null;
  replyToUserId?: string | null;
  replyToName?: string | null;

  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  content: string;
  imageUrl?: string | null;
  createdAt: string;
  likes: number;
  repliesCount?: number;
}

export interface ShopProduct {
  id: string;
  name: string;
  brand: string;
  price: number;
  currency: string;
  imageUrl: string;
  tags: string[];
  category: string;
  reason: string;
  affiliate?: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  name: string;
  score: number;
  trend: "up" | "down" | "same";
  isUser: boolean;
}

export interface SocialProfile {
  userId: string;
  name: string;
  avatarUrl: string;
  role: string;
  postsCount: number;
  followersCount: number;
  likesReceived: number;
}

// ─── Explore Service ──────────────────────────────────────────────────────────

export const exploreService = {
  // ══════════════════════════════════════════════════════════════════════════
  // NEWS
  // ══════════════════════════════════════════════════════════════════════════

  // Fetch news articles with optional filter & pagination
  async getNews(opts: {
    category?: string;
    q?: string;
    limit?: number;
    after?: string; // ISO date cursor for pagination
  }): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 20, 50);

    let query = db.collection(COL_NEWS).orderBy("date", "desc");

    if (opts.category) {
      query = query.where("category", "==", opts.category) as any;
    }
    if (opts.after) {
      query = query.startAfter(opts.after) as any;
    }

    // Fetch limit+1 to detect hasMore
    const snap = await (query as any).limit(limit + 1).get();
    const docs = snap.docs as any[];

    const hasMore = docs.length > limit;
    const sliced = hasMore ? docs.slice(0, limit) : docs;

    let articles: NewsArticle[] = sliced.map((d: any) => ({
      id: d.id,
      ...d.data(),
    })) as NewsArticle[];

    // Simple in-memory search filter (Firestore does not support full-text search natively)
    if (opts.q) {
      const q = opts.q.toLowerCase();
      articles = articles.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.summary.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q),
      );
    }

    return { articles, hasMore };
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SOCIAL POSTS
  // ══════════════════════════════════════════════════════════════════════════

  // Fetch feed with optional type filter & cursor-based pagination
  async getPosts(opts: {
    type?: PostType | "all";
    limit?: number;
    after?: string; // postId cursor
  }): Promise<{ posts: SocialPost[]; hasMore: boolean }> {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 20, 50);

    let query: any = db.collection(COL_POSTS).orderBy("createdAt", "desc");

    if (opts.type && opts.type !== "all") {
      query = query.where("type", "==", opts.type);
    }
    if (opts.after) {
      const cursorDoc = await db.collection(COL_POSTS).doc(opts.after).get();
      if (cursorDoc.exists) query = query.startAfter(cursorDoc);
    }

    const snap = await query.limit(limit + 1).get();
    const docs = snap.docs as any[];
    const hasMore = docs.length > limit;
    const posts = (hasMore ? docs.slice(0, limit) : docs).map((d: any) => ({
      id: d.id,
      ...d.data(),
    })) as SocialPost[];

    return { posts, hasMore };
  },

  // Create a new post
  async createPost(
    userId: string,
    data: {
      content: string;
      type?: PostType;
      mediaUrl?: string;
      videoThumbnail?: string;
      duration?: string;
      eventDate?: string;
      members?: number;
    },
  ): Promise<SocialPost> {
    const db = getDb();
    const userDoc = await db.collection(COL_USERS).doc(userId).get();
    if (!userDoc.exists) throw httpError("User not found.", 404);

    const userData = userDoc.data() as Record<string, any>;
    const authorName = userData["displayName"] ?? "Anonymous";
    const now = new Date().toISOString();

    const newPost: Omit<SocialPost, "id"> = {
      type: data.type ?? "post",
      authorId: userId,
      authorName,
      authorAvatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(authorName)}&background=0D8ABC&color=fff`,
      content: data.content,
      mediaUrl: data.mediaUrl ?? null,
      videoThumbnail: data.videoThumbnail ?? null,
      duration: data.duration ?? null,
      eventDate: data.eventDate ?? null,
      attendees: 0,
      members: data.members ?? 0,
      likes: 0,
      comments: 0,
      createdAt: now,
    };

    const ref = db.collection(COL_POSTS).doc();
    await ref.set(newPost);

    // Increment postsCount in the user's social_stats
    await this._incrementSocialStat(userId, { postsCount: 1 });

    return { id: ref.id, ...newPost };
  },

  // Like / Unlike a post (atomic increment, prevents double-like)
  async toggleLike(
    postId: string,
    userId: string,
  ): Promise<{ liked: boolean; likes: number }> {
    const db = getDb();
    const postRef = db.collection(COL_POSTS).doc(postId);
    const likeRef = postRef.collection("likes").doc(userId);

    const [postSnap, likeSnap] = await Promise.all([
      postRef.get(),
      likeRef.get(),
    ]);

    if (!postSnap.exists) throw httpError("Post not found.", 404);

    const alreadyLiked = likeSnap.exists;

    if (alreadyLiked) {
      await Promise.all([
        likeRef.delete(),
        postRef.update({ likes: FieldValue.increment(-1) }),
        this._incrementSocialStat(postSnap.data()!["authorId"], {
          likesReceived: -1,
        }),
      ]);
      const updated = await postRef.get();
      return { liked: false, likes: updated.data()?.["likes"] ?? 0 };
    } else {
      await Promise.all([
        likeRef.set({ userId, createdAt: new Date().toISOString() }),
        postRef.update({ likes: FieldValue.increment(1) }),
        this._incrementSocialStat(postSnap.data()!["authorId"], {
          likesReceived: 1,
        }),
      ]);
      const updated = await postRef.get();
      return { liked: true, likes: updated.data()?.["likes"] ?? 0 };
    }
  },

  // Toggle RSVP for an event post (atomic)
  async rsvpEvent(
    postId: string,
    userId: string,
  ): Promise<{ rsvp: boolean; attendees: number }> {
    const db = getDb();
    const postRef = db.collection(COL_POSTS).doc(postId);
    const attendeeRef = postRef.collection("attendees").doc(userId);

    const [postSnap, rsvpSnap] = await Promise.all([
      postRef.get(),
      attendeeRef.get(),
    ]);

    if (!postSnap.exists) throw httpError("Event not found.", 404);
    if (postSnap.data()?.["type"] !== "event") {
      throw httpError("Post is not an event.", 400);
    }

    const alreadyRsvp = rsvpSnap.exists;

    if (alreadyRsvp) {
      await Promise.all([
        attendeeRef.delete(),
        postRef.update({ attendees: FieldValue.increment(-1) }),
      ]);
    } else {
      await Promise.all([
        attendeeRef.set({ userId, rsvpAt: new Date().toISOString() }),
        postRef.update({ attendees: FieldValue.increment(1) }),
      ]);
    }

    const updated = await postRef.get();
    const attendees = updated.data()?.["attendees"] ?? 0;
    return { rsvp: !alreadyRsvp, attendees };
  },

  // Join / Leave a group post (atomic)
  async joinGroup(
    postId: string,
    userId: string,
  ): Promise<{ joined: boolean; members: number }> {
    const db = getDb();
    const postRef = db.collection(COL_POSTS).doc(postId);
    const memberRef = postRef.collection("members").doc(userId);

    const [postSnap, memberSnap] = await Promise.all([
      postRef.get(),
      memberRef.get(),
    ]);

    if (!postSnap.exists) throw httpError("Group not found.", 404);
    if (postSnap.data()?.["type"] !== "group") {
      throw httpError("Post is not a group.", 400);
    }

    const isMember = memberSnap.exists;

    if (isMember) {
      await Promise.all([
        memberRef.delete(),
        postRef.update({ members: FieldValue.increment(-1) }),
      ]);
    } else {
      await Promise.all([
        memberRef.set({ userId, joinedAt: new Date().toISOString() }),
        postRef.update({ members: FieldValue.increment(1) }),
      ]);
    }

    const updated = await postRef.get();
    return { joined: !isMember, members: updated.data()?.["members"] ?? 0 };
  },

  // ══════════════════════════════════════════════════════════════════════════
  // POST COMMENTS
  // ══════════════════════════════════════════════════════════════════════════

  async getPostComments(
    postId: string,
    currentUserId: string,
    opts: { sort?: "top" | "newest"; limit?: number; parentId?: string | null },
  ): Promise<{ comments: (SocialComment & { likedByMe: boolean })[] }> {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 20, 50);

    const parentId = opts.parentId ?? null;

    const snap = await db
      .collection(COL_POSTS)
      .doc(postId)
      .collection("comments")
      .where("parentId", "==", parentId)
      .get();

    const comments: (SocialComment & { likedByMe: boolean })[] = [];

    for (const doc of snap.docs) {
      const data = doc.data();
      const likeSnap = await doc.ref
        .collection("likes")
        .doc(currentUserId)
        .get();

      comments.push({
        id: doc.id,
        postId: data.postId,
        parentId: data.parentId ?? null,

        replyToCommentId: data.replyToCommentId ?? null,
        replyToUserId: data.replyToUserId ?? null,
        replyToName: data.replyToName ?? null,

        authorId: data.authorId,
        authorName: data.authorName,
        authorAvatar: data.authorAvatar,
        content: data.content,
        imageUrl: data.imageUrl,
        createdAt: data.createdAt,
        likes: data.likes || 0,
        repliesCount: data.repliesCount || 0,
        likedByMe: likeSnap.exists,
      });
    }

    comments.sort((a, b) => {
      if (opts.sort === "top") {
        return b.likes - a.likes;
      }

      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return { comments: comments.slice(0, limit) };
  },

  async createPostComment(
    userId: string,
    data: {
      postId: string;
      content: string;
      parentId?: string | null;
      replyToCommentId?: string | null;
      imageBase64?: string | null;
    },
  ): Promise<SocialComment> {
    const db = getDb();

    const userDoc = await db.collection(COL_USERS).doc(userId).get();
    if (!userDoc.exists) throw httpError("User not found.", 404);

    const userData = userDoc.data() as Record<string, any>;
    const authorName = userData["displayName"] ?? "Anonymous";

    const postRef = db.collection(COL_POSTS).doc(data.postId);
    const commentRef = postRef.collection("comments").doc();

    const now = new Date().toISOString();
    const imageUrl = data.imageBase64 || null;

    const trimmedContent = data.content.trim();
    if (!trimmedContent) throw httpError("Comment content is required.", 400);

    const replyTargetId = data.replyToCommentId ?? data.parentId ?? null;

    let parentId: string | null = null;
    let replyToCommentId: string | null = null;
    let replyToUserId: string | null = null;
    let replyToName: string | null = null;

    await db.runTransaction(async (tx) => {
      const postSnap = await tx.get(postRef);
      if (!postSnap.exists) throw httpError("Post not found.", 404);

      if (replyTargetId) {
        const targetRef = postRef.collection("comments").doc(replyTargetId);
        const targetSnap = await tx.get(targetRef);

        if (!targetSnap.exists) {
          throw httpError("Reply target comment not found.", 404);
        }

        const targetData = targetSnap.data() as Record<string, any>;

        /**
         * Penting:
         * - Kalau reply ke top-level comment, parentId = target comment id.
         * - Kalau reply ke reply lain, parentId tetap diarahkan ke root comment.
         * Ini membuat thread tidak pecah dan semua reply tetap muncul di bawah comment utama.
         */
        parentId = targetData.parentId ?? targetSnap.id;
        replyToCommentId = targetSnap.id;
        replyToUserId = targetData.authorId ?? null;
        replyToName = targetData.authorName ?? null;
      }

      const newComment: SocialComment = {
        id: commentRef.id,
        postId: data.postId,
        parentId,

        replyToCommentId,
        replyToUserId,
        replyToName,

        authorId: userId,
        authorName,
        authorAvatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(
          authorName,
        )}&background=0D8ABC&color=fff`,
        content: trimmedContent,
        imageUrl,
        createdAt: now,
        likes: 0,
        repliesCount: 0,
      };

      tx.set(commentRef, newComment);

      if (parentId) {
        const rootParentRef = postRef.collection("comments").doc(parentId);
        tx.update(rootParentRef, {
          repliesCount: FieldValue.increment(1),
        });
      }

      tx.update(postRef, {
        comments: FieldValue.increment(1),
      });
    });

    return {
      id: commentRef.id,
      postId: data.postId,
      parentId,
      replyToCommentId,
      replyToUserId,
      replyToName,
      authorId: userId,
      authorName,
      authorAvatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(
        authorName,
      )}&background=0D8ABC&color=fff`,
      content: trimmedContent,
      imageUrl,
      createdAt: now,
      likes: 0,
      repliesCount: 0,
    };
  },

  async toggleCommentLike(
    commentId: string,
    userId: string,
  ): Promise<{ liked: boolean; likes: number }> {
    const db = getDb();

    // Find the comment via collectionGroup because we don't receive postId
    const snap = await db
      .collectionGroup("comments")
      .where("id", "==", commentId)
      .limit(1)
      .get();

    if (snap.empty) {
      throw httpError("Comment not found.", 404);
    }

    const commentDoc = snap.docs[0];
    const commentRef = commentDoc.ref;
    const likeRef = commentRef.collection("likes").doc(userId);

    const likeSnap = await likeRef.get();
    const alreadyLiked = likeSnap.exists;

    if (alreadyLiked) {
      await Promise.all([
        likeRef.delete(),
        commentRef.update({ likes: FieldValue.increment(-1) }),
      ]);
      const updated = await commentRef.get();
      return { liked: false, likes: updated.data()?.["likes"] ?? 0 };
    } else {
      await Promise.all([
        likeRef.set({ userId, createdAt: new Date().toISOString() }),
        commentRef.update({ likes: FieldValue.increment(1) }),
      ]);
      const updated = await commentRef.get();
      return { liked: true, likes: updated.data()?.["likes"] ?? 0 };
    }
  },

  // ══════════════════════════════════════════════════════════════════════════
  // LEADERBOARD
  // ══════════════════════════════════════════════════════════════════════════

  // Fetch top-N users by currentXp, mark the entry belonging to the current user
  async getLeaderboard(
    currentUserId: string,
    limit = 10,
  ): Promise<LeaderboardEntry[]> {
    const db = getDb();
    const snap = await db
      .collection(COL_USERS)
      .where("isCalibrationComplete", "==", true)
      .orderBy("currentXp", "desc")
      .limit(limit)
      .get();

    const entries: LeaderboardEntry[] = snap.docs.map((d, idx) => {
      const data = d.data() as Record<string, any>;
      const prevXp = data["prevXp"] ?? 0;
      const curXp = data["currentXp"] ?? 0;
      const trend: "up" | "down" | "same" =
        curXp > prevXp ? "up" : curXp < prevXp ? "down" : "same";

      return {
        rank: idx + 1,
        userId: d.id,
        name: data["displayName"] ?? "Agent",
        score: curXp,
        trend,
        isUser: d.id === currentUserId,
      };
    });

    // If the current user is not in the top-N, inject their position at the end
    const isInList = entries.some((e) => e.isUser);
    if (!isInList) {
      const myDoc = await db.collection(COL_USERS).doc(currentUserId).get();
      if (myDoc.exists) {
        const d = myDoc.data() as Record<string, any>;
        entries.push({
          rank: limit + 1,
          userId: currentUserId,
          name: d["displayName"] ?? "You",
          score: d["currentXp"] ?? 0,
          trend: "same",
          isUser: true,
        });
      }
    }

    return entries;
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SOCIAL PROFILE
  // ══════════════════════════════════════════════════════════════════════════

  async getSocialProfile(userId: string): Promise<SocialProfile> {
    const db = getDb();
    const userDoc = await db.collection(COL_USERS).doc(userId).get();
    if (!userDoc.exists) throw httpError("User not found.", 404);

    const userData = userDoc.data() as Record<string, any>;

    // Read stats from the social_stats sub-collection (single counter document)
    const statsRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SOCIAL)
      .doc("counts");
    const statsSnap = await statsRef.get();
    const stats = statsSnap.exists
      ? (statsSnap.data() as Record<string, any>)
      : {};

    const name = userData["displayName"] ?? "Agent";

    return {
      userId,
      name,
      avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=0D8ABC&color=fff`,
      role: userData["rankTitle"] ?? "Health Enthusiast",
      postsCount: stats["postsCount"] ?? 0,
      followersCount: stats["followersCount"] ?? 0,
      likesReceived: stats["likesReceived"] ?? 0,
    };
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SHOP
  // ══════════════════════════════════════════════════════════════════════════

  // Fetch all products with optional filters
  async getProducts(opts: {
    category?: string;
    tag?: string;
    limit?: number;
  }): Promise<ShopProduct[]> {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 50, 100);

    let query: any = db.collection(COL_PRODUCTS).limit(limit);

    if (opts.category) {
      query = query.where("category", "==", opts.category);
    }
    if (opts.tag) {
      query = query.where("tags", "array-contains", opts.tag);
    }

    const snap = await query.get();
    return (snap.docs as any[]).map((d: any) => ({
      id: d.id,
      ...d.data(),
    })) as ShopProduct[];
  },

  // Return personalized product recommendations based on the user's Firestore data
  async getRecommendations(userId: string): Promise<ShopProduct[]> {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];

    // Read user profile
    const userDoc = await db.collection(COL_USERS).doc(userId).get();
    if (!userDoc.exists) throw httpError("User not found.", 404);
    const userData = userDoc.data() as Record<string, any>;
    const profile = userData["profile"];
    const goalMode = profile?.goalMode ?? "maintain";
    const sugarLimit: number = profile?.sugarLimit ?? 25;
    const medConditions: string[] = profile?.medicalConditions ?? [];

    // Calculate today's sugar & protein intake from logs
    const logsSnap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection("logs")
      .where("date", "==", today)
      .where("action", "==", "consumed")
      .get();

    let totalSugar = 0;
    let totalProtein = 0;
    logsSnap.docs.forEach((d) => {
      const log = d.data();
      totalSugar += Number(log["sugarg"]) || 0;
      totalProtein += Number(log["macros"]?.protein) || 0;
    });

    // Fetch full product catalog
    const allProducts = await this.getProducts({});

    // Build a priority score for each product
    const scored = allProducts.map((p) => {
      let score = 0;

      // Sugar spike today → boost Sugar Free products
      if (totalSugar > sugarLimit && p.tags.includes("Sugar Free")) score += 30;

      // Low protein today (< 50 g) → boost High Protein products
      if (totalProtein < 50 && p.tags.includes("High Protein")) score += 25;

      // Bulk goal → prioritise High Protein products
      if (goalMode === "bulk" && p.tags.includes("High Protein")) score += 20;

      // Medical conditions
      if (
        (medConditions.includes("diabetes") ||
          medConditions.includes("prediabetes")) &&
        p.tags.includes("Sugar Free")
      )
        score += 40;

      if (medConditions.includes("cholesterol") && p.category === "Supplements")
        score += 10;

      // Monitoring devices — baseline recommendation for everyone
      if (p.category === "Devices") score += 5;

      return { product: p, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Dynamically override the `reason` field based on the user's current context
    return scored.map(({ product, score }) => {
      let reason = product.reason;

      if (totalSugar > sugarLimit && product.tags.includes("Sugar Free")) {
        reason = `You've exceeded your daily sugar limit (${totalSugar.toFixed(0)}g / ${sugarLimit}g).`;
      } else if (totalProtein < 50 && product.tags.includes("High Protein")) {
        reason = `Your protein intake today is only ${totalProtein.toFixed(0)}g — below the 50g target.`;
      }

      return { ...product, reason, _score: score } as ShopProduct & {
        _score: number;
      };
    });
  },

  // Save a product purchase for the user
  async purchaseProduct(
    userId: string,
    productId: string,
  ): Promise<{ success: boolean; purchasedAt: string }> {
    const db = getDb();
    const productRef = db.collection(COL_PRODUCTS).doc(productId);
    const productDoc = await productRef.get();
    if (!productDoc.exists) throw httpError("Product not found.", 404);

    const purchasedAt = new Date().toISOString();
    const purchaseRef = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_PURCHASES)
      .doc(productId); // doc ID equals productId for easy duplicate checks

    await purchaseRef.set({ productId, purchasedAt, userId }, { merge: true });

    return { success: true, purchasedAt };
  },

  // Return the list of productIds the user has already purchased
  async getPurchases(userId: string): Promise<string[]> {
    const db = getDb();
    const snap = await db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_PURCHASES)
      .get();
    return snap.docs.map((d) => d.id); // doc id == productId
  },

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  async _incrementSocialStat(
    userId: string,
    delta: Partial<
      Record<"postsCount" | "followersCount" | "likesReceived", number>
    >,
  ): Promise<void> {
    const db = getDb();
    const ref = db
      .collection(COL_USERS)
      .doc(userId)
      .collection(SUB_SOCIAL)
      .doc("counts");

    const updates: Record<string, any> = {};
    for (const [key, val] of Object.entries(delta)) {
      if (val !== undefined) updates[key] = FieldValue.increment(val);
    }

    await ref.set(updates, { merge: true });
  },
};
