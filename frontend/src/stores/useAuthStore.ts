import { create } from 'zustand';
import api from '../lib/api';
import { initSocket, disconnectSocket } from '../lib/socket';
import type { AuthUser } from '../types';

interface AuthState {
  token: string | null;
  socketToken: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  isHydrated: boolean;

  login: (companySlug: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshSocketToken: () => Promise<string>;
  hydrate: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token:           localStorage.getItem('auth_token'),
  socketToken:     localStorage.getItem('socket_token'),
  user:            null,
  isAuthenticated: !!localStorage.getItem('auth_token'),
  isHydrated:      false,

  login: async (companySlug, email, password) => {
    const { data } = await api.post('/auth/login', {
      company_slug: companySlug,
      email,
      password,
    });

    localStorage.setItem('auth_token',   data.token);
    localStorage.setItem('socket_token', data.socket_token);

    const user: AuthUser = {
      id:                  data.user.id,
      name:                data.user.name,
      email:               data.user.email,
      role:                data.user.role,
      companyId:           data.user.company_id,
      skillTags:           data.user.skill_tags ?? [],
      maxConcurrentChats:  data.user.max_concurrent_chats ?? 5,
      avatarUrl:           data.user.avatar_url ?? null,
      timezone:            data.user.timezone,
    };

    set({ token: data.token, socketToken: data.socket_token, user, isAuthenticated: true, isHydrated: true });
    initSocket(data.socket_token);
  },

  logout: () => {
    api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('auth_token');
    localStorage.removeItem('socket_token');
    disconnectSocket();
    set({ token: null, socketToken: null, user: null, isAuthenticated: false, isHydrated: false });
  },

  refreshSocketToken: async () => {
    const { data } = await api.post('/auth/refresh');
    const newToken = data.socket_token as string;
    localStorage.setItem('socket_token', newToken);
    set({ socketToken: newToken });
    return newToken;
  },

  hydrate: async () => {
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    try {
      const { data } = await api.get('/auth/me');
      const user: AuthUser = {
        id:                  data.id,
        name:                data.name,
        email:               data.email,
        role:                data.role,
        companyId:           data.company_id,
        skillTags:           data.skill_tags ?? [],
        maxConcurrentChats:  data.max_concurrent_chats ?? 5,
        avatarUrl:           data.avatar_url ?? null,
        timezone:            data.timezone,
      };
      set({ user, isAuthenticated: true, isHydrated: true });

      const socketToken = localStorage.getItem('socket_token') ?? '';
      if (socketToken) initSocket(socketToken);
    } catch {
      get().logout();
    }
  },
}));
