import type { FastifyInstance, FastifyReply } from "fastify";
import { exploreService, type PostType } from "../services/explore.service.js";
import { authenticate } from "../middleware/authenticate.js";

// ─── Route Error Handler ──────────────────────────────────────────────────────

function handleError(err: unknown, reply: FastifyReply): void {
  const e = err as Error & { statusCode?: number };
  reply
    .code(e.statusCode ?? 500)
    .send({ error: e.message ?? "An internal server error occurred." });
}

// ─── Explore Routes ───────────────────────────────────────────────────────────

export async function exploreRoutes(app: FastifyInstance): Promise<void> {

  // ══════════════════════════════════════════════════════════════════════════
  // NEWS
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /explore/news ─────────────────────────────────────────────────────
  // Ambil artikel berita. Optional filter: category, q (search), limit, after (cursor).
  app.get<{
    Querystring: { category?: string; q?: string; limit?: number; after?: string };
  }>(
    "/explore/news",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            category: { type: "string" },
            q:        { type: "string" },
            limit:    { type: "number", minimum: 1, maximum: 50 },
            after:    { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.getNews({
          category: request.query.category,
          q:        request.query.q,
          limit:    request.query.limit,
          after:    request.query.after,
        });
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SOCIAL POSTS
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /explore/posts ────────────────────────────────────────────────────
  // Ambil social posts. Optional filter: type (post|event|video|group|all), limit, after (postId cursor).
  app.get<{
    Querystring: { type?: string; limit?: number; after?: string };
  }>(
    "/explore/posts",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            type:  { type: "string", enum: ["post", "event", "video", "group", "all"] },
            limit: { type: "number", minimum: 1, maximum: 50 },
            after: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.getPosts({
          type:  request.query.type as PostType | "all" | undefined,
          limit: request.query.limit,
          after: request.query.after,
        });
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/posts ───────────────────────────────────────────────────
  // Buat post baru. Body: { content, type?, mediaUrl?, videoThumbnail?, duration?, eventDate? }
  app.post<{
    Body: {
      content:         string;
      type?:           PostType;
      mediaUrl?:       string;
      videoThumbnail?: string;
      duration?:       string;
      eventDate?:      string;
    };
  }>(
    "/explore/posts",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["content"],
          properties: {
            content:         { type: "string", minLength: 1, maxLength: 1000 },
            type:            { type: "string", enum: ["post", "event", "video", "group"] },
            mediaUrl:        { type: "string" },
            videoThumbnail:  { type: "string" },
            duration:        { type: "string" },
            eventDate:       { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const post = await exploreService.createPost(request.user.uid, request.body);
        return reply.code(201).send(post);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/posts/:id/like ──────────────────────────────────────────
  // Toggle like pada sebuah post. Mencegah double-like per user.
  app.post<{ Params: { id: string } }>(
    "/explore/posts/:id/like",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        params: {
          type:       "object",
          required:   ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.toggleLike(
          request.params.id,
          request.user.uid,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/events/:id/rsvp ────────────────────────────────────────
  // Toggle RSVP ke sebuah event post. Returns { rsvp: boolean, attendees: number }.
  app.post<{ Params: { id: string } }>(
    "/explore/events/:id/rsvp",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: {
          type:       "object",
          required:   ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.rsvpEvent(
          request.params.id,
          request.user.uid,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/posts/:id/rsvp (alias — FE compat) ─────────────────────
  app.post<{ Params: { id: string } }>(
    "/explore/posts/:id/rsvp",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: {
          type:       "object",
          required:   ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.rsvpEvent(
          request.params.id,
          request.user.uid,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/groups/:id/join ─────────────────────────────────────────
  // Toggle join/leave sebuah group post. Returns { joined: boolean, members: number }.
  app.post<{ Params: { id: string } }>(
    "/explore/groups/:id/join",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: {
          type:       "object",
          required:   ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.joinGroup(
          request.params.id,
          request.user.uid,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/posts/:id/join (alias — FE compat) ────────────────────
  app.post<{ Params: { id: string } }>(
    "/explore/posts/:id/join",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: {
          type:       "object",
          required:   ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.joinGroup(
          request.params.id,
          request.user.uid,
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // POST COMMENTS
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /explore/posts/:id/comments ───────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { sort?: "top" | "newest"; limit?: number; parentId?: string };
  }>(
    "/explore/posts/:id/comments",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            sort: { type: "string", enum: ["top", "newest"] },
            limit: { type: "number", minimum: 1, maximum: 50 },
            parentId: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.getPostComments(
          request.params.id,
          request.user.uid,
          {
            sort: request.query.sort,
            limit: request.query.limit,
            parentId: request.query.parentId,
          }
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/posts/:id/comments ──────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { content: string; parentId?: string; imageBase64?: string };
  }>(
    "/explore/posts/:id/comments",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "string", minLength: 1, maxLength: 2000 },
            parentId: { type: "string" },
            imageBase64: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.createPostComment(
          request.user.uid,
          {
            postId: request.params.id,
            content: request.body.content,
            parentId: request.body.parentId,
            imageBase64: request.body.imageBase64,
          }
        );
        return reply.code(201).send({ success: true, comment: result });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/comments/:id/like ───────────────────────────────────────
  app.post<{
    Params: { id: string };
  }>(
    "/explore/comments/:id/like",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.toggleCommentLike(
          request.params.id,
          request.user.uid
        );
        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // LEADERBOARD
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /explore/leaderboard ──────────────────────────────────────────────
  // Leaderboard berdasarkan XP. Current user selalu ditandai & di-inject jika tidak masuk top-N.
  app.get<{ Querystring: { limit?: number } }>(
    "/explore/leaderboard",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "number", minimum: 3, maximum: 50 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const entries = await exploreService.getLeaderboard(
          request.user.uid,
          request.query.limit ?? 10,
        );
        return reply.send({ leaderboard: entries });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SOCIAL PROFILE
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /explore/profile ──────────────────────────────────────────────────
  // Profil sosial current user: posts, followers, likes yang diterima.
  app.get(
    "/explore/profile",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const profile = await exploreService.getSocialProfile(request.user.uid);
        return reply.send(profile);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SHOP
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /explore/shop/products ────────────────────────────────────────────
  // Katalog produk. Optional filter: category, tag, limit.
  app.get<{
    Querystring: { category?: string; tag?: string; limit?: number };
  }>(
    "/explore/shop/products",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            category: { type: "string" },
            tag:      { type: "string" },
            limit:    { type: "number", minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const products = await exploreService.getProducts({
          category: request.query.category,
          tag:      request.query.tag,
          limit:    request.query.limit,
        });
        return reply.send({ products });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /explore/shop/recommendations ────────────────────────────────────
  // Produk dipersonalisasi berdasarkan data user (sugar intake hari ini, protein, goals, kondisi medis).
  app.get(
    "/explore/shop/recommendations",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const products = await exploreService.getRecommendations(request.user.uid);
        return reply.send({ products });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/shop/purchase ───────────────────────────────────────────
  // Catat pembelian produk. Body: { productId }
  app.post<{ Body: { productId: string } }>(
    "/explore/shop/purchase",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type:       "object",
          required:   ["productId"],
          properties: { productId: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.purchaseProduct(
          request.user.uid,
          request.body.productId,
        );
        return reply.code(201).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── POST /explore/shop/:productId/purchase (alias — FE compat) ───────────
  // FE memanggil /explore/shop/{productId}/purchase dengan param di URL.
  app.post<{ Params: { productId: string } }>(
    "/explore/shop/:productId/purchase",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: {
          type:       "object",
          required:   ["productId"],
          properties: { productId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await exploreService.purchaseProduct(
          request.user.uid,
          request.params.productId,
        );
        return reply.code(201).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // ── GET /explore/shop/purchases ───────────────────────────────────────────
  // Daftar productId yang sudah dibeli current user (untuk menampilkan status "Owned").
  app.get(
    "/explore/shop/purchases",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const purchasedIds = await exploreService.getPurchases(request.user.uid);
        return reply.send({ purchasedIds });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
