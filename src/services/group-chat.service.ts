import {
  FieldValue,
  type DocumentReference,
  type WriteBatch,
} from "firebase-admin/firestore";
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

export interface GroupInviteeSearchResult {
  id: string;
  displayName: string;
  avatarUrl: string;
}

function formatNameList(names: string[]): string {
  const cleanNames = names.map((name) => name.trim()).filter(Boolean);

  if (cleanNames.length === 0) return "member";
  if (cleanNames.length === 1) return cleanNames[0];
  if (cleanNames.length === 2) return `${cleanNames[0]} and ${cleanNames[1]}`;

  return `${cleanNames.slice(0, 2).join(", ")} and ${cleanNames.length - 2} others`;
}

function queueSystemMessage(
  batch: WriteBatch,
  groupRef: DocumentReference,
  payload: {
    groupId: string;
    text: string;
    eventType: "member_invited" | "member_joined" | "member_left";
    actorId: string;
    actorName: string;
    targetUserIds?: string[];
    createdAt: string;
  },
) {
  const msgRef = groupRef.collection(SUB_MESSAGES).doc();
  const message = {
    id: msgRef.id,
    groupId: payload.groupId,
    senderId: "system",
    senderName: "System",
    senderAvatar: "",
    text: payload.text,
    type: "system",
    eventType: payload.eventType,
    actorId: payload.actorId,
    actorName: payload.actorName,
    targetUserIds: payload.targetUserIds ?? [],
    createdAt: payload.createdAt,
    editedAt: null,
    deletedAt: null,
  };

  batch.set(msgRef, message);
  return message;
}

export const groupChatService = {
  async searchInvitees(
    userId: string,
    query: string,
  ): Promise<GroupInviteeSearchResult[]> {
    const db = getDb();
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) return [];

    const variants = [
      normalizedQuery,
      normalizedQuery.toLowerCase(),
      normalizedQuery.toUpperCase(),
      normalizedQuery.charAt(0).toUpperCase() +
        normalizedQuery.slice(1).toLowerCase(),
    ];

    const snapshots = await Promise.all(
      [...new Set(variants)].map((variant) =>
        db
          .collection(COL_USERS)
          .orderBy("displayName")
          .startAt(variant)
          .endAt(`${variant}\uf8ff`)
          .limit(10)
          .get(),
      ),
    );

    const results = new Map<string, GroupInviteeSearchResult>();

    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        if (doc.id === userId || results.has(doc.id)) continue;

        const data = doc.data();
        const displayName = String(data["displayName"] ?? "").trim();
        if (!displayName) continue;

        results.set(doc.id, {
          id: doc.id,
          displayName,
          avatarUrl: String(data["photoURL"] ?? ""),
        });
      }
    }

    return [...results.values()]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .slice(0, 10);
  },

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

    const inviteeDocs = await Promise.all(
      uniqueInvitees.map((inviteeId) =>
        db.collection(COL_USERS).doc(inviteeId).get(),
      ),
    );

    const validInvitees = inviteeDocs.filter((doc) => doc.exists);
    const memberIds = [ownerId, ...validInvitees.map((doc) => doc.id)];
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
      avatarUrl: String(owner["photoURL"] ?? ""),
      role: "owner",
      status: "joined",
      invitedBy: ownerId,
      invitedAt: now,
      joinedAt: now,
      lastReadAt: now,
      leftAt: null,
    });

    for (const userDoc of validInvitees) {
      const inviteeId = userDoc.id;
      const user = userDoc.data() ?? {};

      batch.set(groupRef.collection(SUB_MEMBERS).doc(inviteeId), {
        userId: inviteeId,
        displayName: user["displayName"] ?? "Agent",
        avatarUrl: String(user["photoURL"] ?? ""),
        role: "member",
        status: "invited",
        invitedBy: ownerId,
        invitedAt: now,
        joinedAt: null,
        lastReadAt: null,
        leftAt: null,
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

    const groups = await Promise.all(
      snap.docs.map(async (doc) => {
        const group = doc.data();
        const [memberDoc, membersSnap] = await Promise.all([
          doc.ref.collection(SUB_MEMBERS).doc(userId).get(),
          doc.ref.collection(SUB_MEMBERS).get(),
        ]);
        const member = memberDoc.data() ?? {};

        const members = membersSnap.docs
          .map((memberDoc) => {
            const data = memberDoc.data() ?? {};

            return {
              id: memberDoc.id,
              userId: data["userId"] ?? memberDoc.id,
              displayName: data["displayName"] ?? "Agent",
              avatarUrl: data["avatarUrl"] ?? "",
              role: data["role"] ?? "member",
              status: data["status"] ?? "invited",
              invitedAt: data["invitedAt"] ?? null,
              joinedAt: data["joinedAt"] ?? null,
              leftAt: data["leftAt"] ?? null,
            };
          })
          .filter((member) => member.status !== "left");

        return {
          ...group,
          id: doc.id,
          members,
          currentMember: memberDoc.exists
            ? {
                status: member["status"] ?? "invited",
                role: member["role"] ?? "member",
                invitedAt: member["invitedAt"] ?? null,
                joinedAt: member["joinedAt"] ?? null,
                lastReadAt: member["lastReadAt"] ?? null,
              }
            : null,
        };
      }),
    );

    return groups;
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
    const groupRef = db.collection(COL_GROUP_CHATS).doc(groupId);
    const memberRef = groupRef.collection(SUB_MEMBERS).doc(userId);
    const snap = await memberRef.get();

    if (!snap.exists) {
      throw httpError("Invite not found.", 404);
    }

    const member = snap.data() ?? {};

    if (member["status"] === "joined") {
      return { success: true, alreadyJoined: true };
    }

    if (member["status"] !== "invited") {
      throw httpError("You cannot accept this invite.", 403);
    }

    const batch = db.batch();
    const actorName = String(member["displayName"] ?? "Agent");
    const message = queueSystemMessage(batch, groupRef, {
      groupId,
      text: `${actorName} joined the group`,
      eventType: "member_joined",
      actorId: userId,
      actorName,
      targetUserIds: [userId],
      createdAt: now,
    });

    batch.update(memberRef, {
      status: "joined",
      joinedAt: now,
      lastReadAt: now,
      leftAt: null,
    });

    batch.update(groupRef, {
      lastMessageText: message.text,
      lastMessageAt: now,
      updatedAt: now,
    });

    await batch.commit();

    return { success: true, alreadyJoined: false };
  },

  async addMembers(groupId: string, inviterId: string, inviteeIds: string[]) {
    const db = getDb();
    const now = new Date().toISOString();

    const inviterMember = await this.assertJoinedMember(groupId, inviterId);
    const groupRef = db.collection(COL_GROUP_CHATS).doc(groupId);
    const groupSnap = await groupRef.get();

    if (!groupSnap.exists) {
      throw httpError("Group not found.", 404);
    }

    const group = groupSnap.data() ?? {};
    const existingMemberIds = new Set<string>(
      Array.isArray(group["memberIds"]) ? group["memberIds"] : [],
    );

    const uniqueInviteeIds = [...new Set(inviteeIds)]
      .filter((id) => id && id !== inviterId)
      .filter((id) => !existingMemberIds.has(id));

    if (uniqueInviteeIds.length === 0) {
      return {
        success: true,
        addedCount: 0,
        invitedUserIds: [],
      };
    }

    const inviteeDocs = await Promise.all(
      uniqueInviteeIds.map((inviteeId) =>
        db.collection(COL_USERS).doc(inviteeId).get(),
      ),
    );

    const validInvitees = inviteeDocs.filter((doc) => doc.exists);

    if (validInvitees.length === 0) {
      throw httpError("No valid users to invite.", 400);
    }

    const batch = db.batch();
    const invitedUserIds: string[] = [];
    const invitedNames: string[] = [];

    for (const userDoc of validInvitees) {
      const inviteeId = userDoc.id;
      const user = userDoc.data() ?? {};
      const displayName = String(user["displayName"] ?? "Agent");

      invitedUserIds.push(inviteeId);
      invitedNames.push(displayName);

      batch.set(
        groupRef.collection(SUB_MEMBERS).doc(inviteeId),
        {
          userId: inviteeId,
          displayName,
          avatarUrl: String(user["photoURL"] ?? ""),
          role: "member",
          status: "invited",
          invitedBy: inviterId,
          invitedAt: now,
          joinedAt: null,
          lastReadAt: null,
          leftAt: null,
        },
        { merge: true },
      );
    }

    const inviterName = String(inviterMember["displayName"] ?? "Agent");
    const messageText = `${inviterName} invited ${formatNameList(invitedNames)} to the group`;
    const message = queueSystemMessage(batch, groupRef, {
      groupId,
      text: messageText,
      eventType: "member_invited",
      actorId: inviterId,
      actorName: inviterName,
      targetUserIds: invitedUserIds,
      createdAt: now,
    });

    batch.update(groupRef, {
      memberIds: FieldValue.arrayUnion(...invitedUserIds),
      lastMessageText: message.text,
      lastMessageAt: now,
      updatedAt: now,
    });

    await batch.commit();

    return {
      success: true,
      addedCount: invitedUserIds.length,
      invitedUserIds,
    };
  },

  async leaveGroup(groupId: string, userId: string) {
    const db = getDb();
    const now = new Date().toISOString();

    const member = await this.assertJoinedMember(groupId, userId);
    const groupRef = db.collection(COL_GROUP_CHATS).doc(groupId);
    const groupSnap = await groupRef.get();

    if (!groupSnap.exists) {
      throw httpError("Group not found.", 404);
    }

    const group = groupSnap.data() ?? {};
    const memberIds = Array.isArray(group["memberIds"])
      ? (group["memberIds"] as string[])
      : [];
    const remainingMemberIds = memberIds.filter((id) => id !== userId);
    const batch = db.batch();
    const actorName = String(member["displayName"] ?? "Agent");
    const message = queueSystemMessage(batch, groupRef, {
      groupId,
      text: `${actorName} left the group`,
      eventType: "member_left",
      actorId: userId,
      actorName,
      targetUserIds: [userId],
      createdAt: now,
    });

    batch.update(groupRef.collection(SUB_MEMBERS).doc(userId), {
      status: "left",
      role: "member",
      leftAt: now,
      lastReadAt: now,
    });

    const groupUpdate: Record<string, any> = {
      memberIds: FieldValue.arrayRemove(userId),
      lastMessageText: message.text,
      lastMessageAt: now,
      updatedAt: now,
    };

    if (member["role"] === "owner" && remainingMemberIds.length > 0) {
      const remainingMemberDocs = await Promise.all(
        remainingMemberIds.map((memberId) =>
          groupRef.collection(SUB_MEMBERS).doc(memberId).get(),
        ),
      );

      const nextOwnerDoc = remainingMemberDocs.find((doc) => {
        const data = doc.data() ?? {};
        return data["status"] === "joined";
      });

      if (nextOwnerDoc) {
        batch.update(nextOwnerDoc.ref, {
          role: "owner",
        });

        groupUpdate.createdBy = nextOwnerDoc.id;
      }
    }

    batch.update(groupRef, groupUpdate);
    await batch.commit();

    return {
      success: true,
    };
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
      type: "text",
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
