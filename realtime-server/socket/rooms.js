/**
 * Konvensi penamaan room Socket.io.
 * HARUS konsisten antara server dan frontend client.
 */

/**
 * Manager (supervisor+) dalam satu company — broadcast inbox update,
 * assignment, channel health. Role `agent` TIDAK join room ini:
 * mereka hanya menerima event dari channel room yang di-assign.
 */
export const companyRoom = (companyId) => `company:${companyId}`;

/** Satu channel (nomor WA / akun) — inbox update untuk agent ter-assign */
export const channelRoom = (channelId) => `channel:${channelId}`;

/** Satu conversation spesifik — new message, typing, status update */
export const conversationRoom = (conversationId) => `conv:${conversationId}`;

/** Personal room per agent — notifikasi yang hanya untuk satu agen */
export const agentRoom = (agentId) => `agent:${agentId}`;
