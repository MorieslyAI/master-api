import type { FastifyInstance, FastifyReply } from "fastify";
import { authenticate } from "../middleware/authenticate.js";
import { groupChatService } from "../services/group-chat.service.js";

function handleError(err: unknown, reply: FastifyReply) {
  const e = err as Error & { statusCode?: number };

  return reply
    .code(e.statusCode ?? 500)
    .send({ error: e.message ?? "Internal server error." });
}

export async function groupChatRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q: string } }>(
    "/group-chats/users/search",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 2, maxLength: 80 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const users = await groupChatService.searchInvitees(
          request.user.uid,
          request.query.q,
        );

        return reply.send({ users });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.post<{
    Body: { name: string; description?: string; inviteeIds: string[] };
  }>(
    "/group-chats",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["name", "inviteeIds"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            description: { type: "string", maxLength: 300 },
            inviteeIds: {
              type: "array",
              maxItems: 30,
              items: { type: "string" },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await groupChatService.createGroupChat(
          request.user.uid,
          request.body,
        );

        return reply.code(201).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.get(
    "/group-chats",
    { preHandler: authenticate },
    async (request, reply) => {
      try {
        const groups = await groupChatService.listMyGroupChats(
          request.user.uid,
        );
        return reply.send({ groups });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/group-chats/:id/accept",
    { preHandler: authenticate },
    async (request, reply) => {
      try {
        const result = await groupChatService.acceptInvite(
          request.params.id,
          request.user.uid,
        );

        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { inviteeIds: string[] };
  }>(
    "/group-chats/:id/members",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["inviteeIds"],
          properties: {
            inviteeIds: {
              type: "array",
              minItems: 1,
              maxItems: 30,
              items: { type: "string" },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await groupChatService.addMembers(
          request.params.id,
          request.user.uid,
          request.body.inviteeIds,
        );

        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/group-chats/:id/leave",
    { preHandler: authenticate },
    async (request, reply) => {
      try {
        const result = await groupChatService.leaveGroup(
          request.params.id,
          request.user.uid,
        );

        return reply.send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    "/group-chats/:id/messages",
    { preHandler: authenticate },
    async (request, reply) => {
      try {
        const messages = await groupChatService.getMessages(
          request.params.id,
          request.user.uid,
          request.query.limit ?? 50,
        );

        return reply.send({ messages });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/group-chats/:id/messages",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 2000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const message = await groupChatService.sendMessage(
          request.params.id,
          request.user.uid,
          request.body.text,
        );

        return reply.code(201).send(message);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
