import { FieldValue } from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import { getDb } from "../lib/firebase.js";

const COL_GROUP_CHATS = "group_chats";
const COL_USERS = "users";
const SUB_MEMBERS = "members";
const SUB_MESSAGES = "messages";

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export interface CreateGroupChatDTO {
  name: string;
  description?: string;
  inviteeIds: string[];
}

export const groupChatService = {
  async createGroupChat(ownerId: string, payload: CreateGroupChatDTO) {
    const db = getDb();
    const now = new Date().toISOString();
    const groupRef = db.collection(COL_GROUP_CHATS).doc();

    const ownerDoc = await db.collection(COL_USERS).doc(ownerId).get();
    if (!ownerDoc.exists) throw httpError("User not found.", 404);

    const owner = ownerDoc.data() ?? {};
    const uniqueInvitees = [...new Set(payload.inviteeIds)].filter(
      (id) => id && id !== ownerId,
    );

    const memberIds = [ownerId, ...uniqueInvitees];

    const batch = db.batch();

    batch.set(groupRef, {
      id: groupRef.id,
      name: payload.name,
      description: payload.description ?? "",
      createdBy: ownerId,
      createdAt: now,
      updatedAt: now,
      lastMessageText: "",
      lastMessageAt: null,
      memberIds,
      isPrivate: true,
    });

    batch.set(groupRef.collection(SUB_MEMBERS).doc(ownerId), {
      userId: ownerId,
      displayName: owner["displayName"] ?? "Agent",
      avatarUrl: "",
      role: "owner",
      status: "joined",
      invitedBy: ownerId,
      invitedAt: now,
      joinedAt: now,
      lastReadAt: now,
    });

    for (const inviteeId of uniqueInvitees) {
      const userDoc = await db.collection(COL_USERS).doc(inviteeId).get();
      if (!userDoc.exists) continue;

      const user = userDoc.data() ?? {};
      batch.set(groupRef.collection(SUB_MEMBERS).doc(inviteeId), {
        userId: inviteeId,
        displayName: user["displayName"] ?? "Agent",
        avatarUrl: "",
        role: "member",
        status: "invited",
        invitedBy: ownerId,
        invitedAt: now,
        joinedAt: null,
        lastReadAt: null,
      });
    }

    await batch.commit();

    return {
      id: groupRef.id,
      name: payload.name,
      memberIds,
    };
  },

  async listMyGroupChats(userId: string) {
    const db = getDb();

    const snap = await db
      .collection(COL_GROUP_CHATS)
      .where("memberIds", "array-contains", userId)
      .orderBy("updatedAt", "desc")
      .limit(50)
      .get();

    return snap.docs.map((doc) => doc.data());
  },

  async assertJoinedMember(groupId: string, userId: string) {
    const memberDoc = await getDb()
      .collection(COL_GROUP_CHATS)
      .doc(groupId)
      .collection(SUB_MEMBERS)
      .doc(userId)
      .get();

    if (!memberDoc.exists) {
      throw httpError("You are not a member of this group.", 403);
    }

    const member = memberDoc.data() ?? {};
    if (member["status"] !== "joined") {
      throw httpError("You have not joined this group yet.", 403);
    }

    return member;
  },

  async acceptInvite(groupId: string, userId: string) {
    const db = getDb();
    const now = new Date().toISOString();

    const memberRef = db
      .collection(COL_GROUP_CHATS)
      .doc(groupId)
      .collection(SUB_MEMBERS)
      .doc(userId);

    const snap = await memberRef.get();
    if (!snap.exists) throw httpError("Invite not found.", 404);

    await memberRef.update({
      status: "joined",
      joinedAt: now,
      lastReadAt: now,
    });

    return { success: true };
  },

  async getMessages(groupId: string, userId: string, limit = 50) {
    await this.assertJoinedMember(groupId, userId);

    const snap = await getDb()
      .collection(COL_GROUP_CHATS)
      .doc(groupId)
      .collection(SUB_MESSAGES)
      .orderBy("createdAt", "desc")
      .limit(Math.min(limit, 100))
      .get();

    return snap.docs.map((doc) => doc.data()).reverse();
  },

  async sendMessage(groupId: string, userId: string, text: string) {
    if (!text.trim()) throw httpError("Message cannot be empty.", 400);
    if (text.length > 2000) throw httpError("Message is too long.", 400);

    const db = getDb();
    const now = new Date().toISOString();

    const member = await this.assertJoinedMember(groupId, userId);

    const groupRef = db.collection(COL_GROUP_CHATS).doc(groupId);
    const msgRef = groupRef.collection(SUB_MESSAGES).doc();

    const message = {
      id: msgRef.id,
      groupId,
      senderId: userId,
      senderName: member["displayName"] ?? "Agent",
      senderAvatar: member["avatarUrl"] ?? "",
      text: text.trim(),
      createdAt: now,
      editedAt: null,
      deletedAt: null,
    };

    const batch = db.batch();

    batch.set(msgRef, message);
    batch.update(groupRef, {
      lastMessageText: message.text,
      lastMessageAt: now,
      updatedAt: now,
    });

    await batch.commit();

    return message;
  },
};