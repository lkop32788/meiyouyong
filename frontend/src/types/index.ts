export type ChannelType = 'whatsapp' | 'line' | 'email' | 'telegram' | 'sms';
export type ConversationStatus = 'pending' | 'open' | 'snoozed' | 'resolved';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type AgentStatus = 'online' | 'offline' | 'busy' | 'away';
export type AgentRole = 'agent' | 'supervisor' | 'admin' | 'super_admin';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: AgentRole;
  companyId: string;
  skillTags: string[];
  maxConcurrentChats: number;
  avatarUrl: string | null;
  timezone: string;
}

export interface ConversationSummary {
  id: string;
  contactName: string | null;
  contactAvatar: string | null;
  channelType: ChannelType;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  lastMessageDirection: MessageDirection | null;
  status: ConversationStatus;
  unreadCount: number;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  priority: Priority;
}

export interface ConversationDetail extends ConversationSummary {
  channelId: string;
  channelName: string | null;
  contactId: string;
  contactEmail: string | null;
  contactPhone: string | null;
  subject: string | null;
  intentTags: string[];
  messageCount: number;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  snoozedUntil: string | null;
  createdAt: string | null;
}

export interface Message {
  id: string;
  tempId?: string;
  conversationId: string;
  direction: MessageDirection;
  senderType: 'contact' | 'agent' | 'bot' | 'system';
  senderId: string;
  contentType: string;
  content: Record<string, unknown>;
  status: MessageStatus;
  providerMessageId?: string;
  providerTimestamp: string | null;
  quotedMessageId?: string | null;
  isDeleted: boolean;
  createdAt: string | null;
}

export interface AgentPresence {
  agentId: string;
  name: string;
  avatarUrl: string | null;
  status: AgentStatus;
  lastSeen: string | null;
  workload?: number;
}
